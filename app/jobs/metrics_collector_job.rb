# frozen_string_literal: true

require 'open3'
require 'socket'
require 'redis'
require 'oj'

class MetricsCollectorJob
  include Sidekiq::Job

  HOST_CACHE_KEY = 'potorix:metrics:host:last'
  VM_CACHE_PREFIX = 'potorix:metrics:vm:last:'

  def perform
    now = Time.now.utc
    collect_host_metrics!(now)
    collect_vm_metrics!(now)
  rescue StandardError
    nil
  ensure
    self.class.perform_in(60)
  end

  private

  def collect_host_metrics!(now)
    cpu_pct = host_cpu_usage_pct
    ram_pct = host_ram_usage_pct
    load_avg = host_load_avg_1m
    rx_rate, tx_rate = host_network_rates

    DB[:host_metrics].insert(
      cpu_usage_pct: cpu_pct,
      ram_usage_pct: ram_pct,
      load_avg_1m: load_avg,
      net_rx_bytes_sec: rx_rate,
      net_tx_bytes_sec: tx_rate,
      created_at: now
    )
  end

  def collect_vm_metrics!(now)
    stats = parse_domstats_all(domstats_all_output)
    return if stats.empty?

    tenant_map = DB[:tenant_vms].all.each_with_object({}) { |r, acc| acc[r[:vm_id].to_s] = r[:tenant_id].to_s }
    stats.each do |vm_id, values|
      normalized_vm = sanitize_vm_id(vm_id)
      tenant_id = tenant_map[normalized_vm]
      next if tenant_id.to_s.empty?

      vcpus = [values['vcpu.current'].to_i, 1].max
      cpu_time_ns = values['cpu.time'].to_i
      mem_current = values['balloon.rss'] ? values['balloon.rss'].to_i : values['balloon.current'].to_i
      mem_max = values['balloon.maximum'].to_i
      mem_pct = mem_max.positive? ? ((mem_current.to_f / mem_max.to_f) * 100.0) : 0.0

      disk_rd_reqs = sum_by_pattern(values, /^block\.\d+\.rd\.reqs$/)
      disk_wr_reqs = sum_by_pattern(values, /^block\.\d+\.wr\.reqs$/)
      net_rx = sum_by_pattern(values, /^net\.\d+\.rx\.bytes$/)
      net_tx = sum_by_pattern(values, /^net\.\d+\.tx\.bytes$/)

      prev = read_cache("#{VM_CACHE_PREFIX}#{normalized_vm}")
      now_ts = now.to_f
      elapsed = prev ? (now_ts - prev[:ts].to_f) : 0.0
      cpu_pct = 0.0
      disk_iops = 0
      net_rx_rate = 0
      net_tx_rate = 0

      if prev && elapsed.positive?
        cpu_delta = [cpu_time_ns - prev[:cpu_time_ns].to_i, 0].max
        cpu_pct = (cpu_delta / (elapsed * 1_000_000_000.0 * vcpus)) * 100.0

        iops_delta = [disk_rd_reqs - prev[:disk_rd_reqs].to_i, 0].max + [disk_wr_reqs - prev[:disk_wr_reqs].to_i, 0].max
        disk_iops = (iops_delta / elapsed).round

        rx_delta = [net_rx - prev[:net_rx].to_i, 0].max
        tx_delta = [net_tx - prev[:net_tx].to_i, 0].max
        net_rx_rate = (rx_delta / elapsed).round
        net_tx_rate = (tx_delta / elapsed).round
      end

      DB[:vm_metrics].insert(
        vm_id: normalized_vm,
        tenant_id: tenant_id,
        cpu_usage_pct: [[cpu_pct, 0.0].max, 100.0].min.round(2),
        ram_usage_pct: [[mem_pct, 0.0].max, 100.0].min.round(2),
        disk_iops: [disk_iops, 0].max,
        net_rx_bytes_sec: [net_rx_rate, 0].max,
        net_tx_bytes_sec: [net_tx_rate, 0].max,
        created_at: now
      )

      write_cache(
        "#{VM_CACHE_PREFIX}#{normalized_vm}",
        ts: now_ts,
        cpu_time_ns: cpu_time_ns,
        disk_rd_reqs: disk_rd_reqs,
        disk_wr_reqs: disk_wr_reqs,
        net_rx: net_rx,
        net_tx: net_tx
      )
    end
  end

  def host_cpu_usage_pct
    row = File.read('/proc/stat').lines.find { |line| line.start_with?('cpu ') }
    return 0.0 unless row

    parts = row.split.drop(1).map(&:to_i)
    idle = parts[3].to_i + parts[4].to_i
    total = parts.sum
    prev = read_cache(HOST_CACHE_KEY)
    write_cache(HOST_CACHE_KEY, total: total, idle: idle, ts: Time.now.to_f)
    return 0.0 unless prev

    total_delta = total - prev[:total].to_i
    idle_delta = idle - prev[:idle].to_i
    return 0.0 if total_delta <= 0

    (((total_delta - idle_delta).to_f / total_delta.to_f) * 100.0).round(2)
  rescue StandardError
    0.0
  end

  def host_ram_usage_pct
    info = File.read('/proc/meminfo').lines.each_with_object({}) do |line, acc|
      key, value = line.split(':', 2)
      next unless key && value

      acc[key.strip] = value.to_s.strip.split.first.to_i
    end
    total = info['MemTotal'].to_i
    available = info['MemAvailable'].to_i
    return 0.0 if total <= 0

    (((total - available).to_f / total.to_f) * 100.0).round(2)
  rescue StandardError
    0.0
  end

  def host_load_avg_1m
    File.read('/proc/loadavg').split.first.to_f.round(3)
  rescue StandardError
    0.0
  end

  def host_network_rates
    rx, tx = network_totals
    now_ts = Time.now.to_f
    prev = read_cache("#{HOST_CACHE_KEY}:net")
    write_cache("#{HOST_CACHE_KEY}:net", rx: rx, tx: tx, ts: now_ts)
    return [0, 0] unless prev

    elapsed = now_ts - prev[:ts].to_f
    return [0, 0] unless elapsed.positive?

    rx_rate = ([rx - prev[:rx].to_i, 0].max / elapsed).round
    tx_rate = ([tx - prev[:tx].to_i, 0].max / elapsed).round
    [rx_rate, tx_rate]
  rescue StandardError
    [0, 0]
  end

  def network_totals
    interfaces = Dir.children('/sys/class/net').reject { |name| name == 'lo' }
    rx_sum = 0
    tx_sum = 0
    interfaces.each do |iface|
      rx_path = "/sys/class/net/#{iface}/statistics/rx_bytes"
      tx_path = "/sys/class/net/#{iface}/statistics/tx_bytes"
      next unless File.file?(rx_path) && File.file?(tx_path)

      rx_sum += File.read(rx_path).to_i
      tx_sum += File.read(tx_path).to_i
    end
    [rx_sum, tx_sum]
  end

  def domstats_all_output
    out, status = Open3.capture2e('virsh', '--connect', ENV.fetch('HYPERVISOR_URI', 'qemu:///system'), 'domstats', '--list-active', '--cpu-total', '--vcpu', '--balloon', '--block', '--interface')
    raise out unless status.success?

    out
  end

  def parse_domstats_all(output)
    current = nil
    acc = {}
    output.to_s.each_line do |line|
      line = line.strip
      next if line.empty?

      if line.start_with?('Domain:')
        current = sanitize_vm_id(line.sub('Domain:', '').strip)
        acc[current] ||= {}
        next
      end
      next if current.nil?

      key, value = line.split('=', 2)
      next if key.to_s.empty? || value.nil?

      acc[current][key.strip] = value.strip
    end
    acc
  end

  def sum_by_pattern(values, pattern)
    values.select { |k, _| k.match?(pattern) }.values.sum { |v| v.to_i }
  end

  def sanitize_vm_id(value)
    value.to_s.gsub(/\A'+|'+\z/, '').gsub(/[^a-zA-Z0-9_.:-]/, '')
  end

  def redis
    @redis ||= Redis.new(url: ENV.fetch('REDIS_URL'))
  end

  def read_cache(key)
    raw = redis.get(key)
    return nil if raw.to_s.empty?

    parsed = Oj.load(raw)
    parsed.transform_keys(&:to_sym)
  rescue StandardError
    nil
  end

  def write_cache(key, payload)
    redis.set(key, Oj.dump(payload))
  rescue StandardError
    nil
  end
end
