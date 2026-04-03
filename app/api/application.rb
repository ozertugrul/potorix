# frozen_string_literal: true

require 'open3'
require 'socket'
require 'faye/websocket'
require 'securerandom'
require 'fileutils'
require_relative '../../config/boot'
require_relative '../../config/database'
require_relative '../services/auth/api_key_auth'
require_relative '../services/hypervisor/virsh_adapter'
require_relative '../services/realtime_stream'
require_relative '../services/operation_store'
require_relative '../services/audit_logger'
require_relative '../services/idempotency_store'
require_relative '../jobs/vm_lifecycle_job'
require_relative '../jobs/app_marketplace_job'
require_relative '../jobs/backup_run_job'

class Application < Sinatra::Base
  set :bind, '0.0.0.0'
  set :port, ENV.fetch('APP_PORT', 9292)
  set :static, true
  set :public_folder, File.expand_path('../../public', __dir__)

  before '/api/*' do
    content_type :json
    auth = Auth::ApiKeyAuth.new
    token = request.env['HTTP_X_API_KEY'].to_s
    token = params['token'].to_s if token.empty?
    @current_role = auth.authenticate!(token)
    tenant_header = request.env['HTTP_X_TENANT_ID'].to_s
    tenant_header = params['tenant'].to_s if tenant_header.empty?
    @tenant_id = sanitize_id(tenant_header)
    halt 400, Oj.dump(error: 'X-Tenant-ID header is required') if @tenant_id.empty?
  rescue Auth::ApiKeyAuth::AuthenticationError => e
    halt 401, Oj.dump(error: e.message)
  end

  error Hypervisor::VirshAdapter::CommandError do
    err = env['sinatra.error']
    status 422
    Oj.dump(error: err.message)
  end

  get '/' do
    content_type 'text/html'
    send_file(File.join(settings.public_folder, 'index.html'))
  end

  get '/novnc-vendor/*' do
    relative = params['splat'].first.to_s
    halt 400, Oj.dump(error: 'invalid asset path') if relative.include?('..')
    base = '/usr/share/novnc'
    file_path = File.expand_path(File.join(base, relative))
    halt 404, Oj.dump(error: 'asset not found') unless file_path.start_with?(base) && File.file?(file_path)
    send_file(file_path)
  end

  get '/ws' do
    halt 426, Oj.dump(error: 'Expected WebSocket upgrade') unless Faye::WebSocket.websocket?(env)

    token = params.fetch('token', '')
    tenant_id = sanitize_id(params.fetch('tenant', ''))
    halt 400, Oj.dump(error: 'tenant query param required') if tenant_id.empty?

    auth = Auth::ApiKeyAuth.new
    auth.authenticate!(token)

    ws = Faye::WebSocket.new(env, nil, ping: 20)
    redis = Redis.new(url: ENV.fetch('REDIS_URL'))

    hello = {
      event_id: "hello-#{Time.now.to_i}",
      event_type: 'ws.connected',
      occurred_at: Time.now.utc.iso8601,
      tenant_id: tenant_id,
      severity: 'info',
      actor: { role: 'system' },
      resource: { type: 'ws', id: 'session' },
      trace: {},
      data: { message: 'WebSocket connected' }
    }
    ws.send(Oj.dump(hello))

    subscriber = Thread.new do
      redis.subscribe(RealtimeStream::CHANNEL) do |on|
        on.message do |_channel, msg|
          event = Oj.load(msg)
          next unless event['tenant_id'].to_s == tenant_id

          ws.send(msg)
        end
      end
    end

    ws.on :close do |_event|
      redis.quit
      subscriber.kill
    end

    ws.rack_response
  rescue Auth::ApiKeyAuth::AuthenticationError => e
    halt 401, Oj.dump(error: e.message)
  end

  get '/ws/vnc' do
    halt 426, Oj.dump(error: 'Expected WebSocket upgrade') unless Faye::WebSocket.websocket?(env)

    token = params.fetch('token', '')
    tenant_id = sanitize_id(params.fetch('tenant', ''))
    vm_id = sanitize_id(params.fetch('vm_id', ''))
    halt 400, Oj.dump(error: 'tenant query param required') if tenant_id.empty?
    halt 400, Oj.dump(error: 'vm_id query param required') if vm_id.empty?

    auth = Auth::ApiKeyAuth.new
    role = auth.authenticate!(token)
    Auth::ApiKeyAuth.new.authorize!(role, 'vm:read')
    vm_exists = DB[:tenant_vms].where(tenant_id: tenant_id, vm_id: vm_id).count.positive?
    halt 404, Oj.dump(error: 'VM not found in tenant scope') unless vm_exists

    display = Hypervisor::VirshAdapter.new.vnc_display(vm_id)
    halt 409, Oj.dump(error: 'VM is not running; VNC not available') if display.nil?
    port = display.start_with?(':') ? (5900 + display[1..].to_i) : Integer(display)
    target_host = ENV.fetch('VNC_PROXY_TARGET_HOST', default_gateway_ip)
    logger.info("[ws/vnc] tenant=#{tenant_id} vm=#{vm_id} target=#{target_host}:#{port}")

    ws = Faye::WebSocket.new(env, nil, ping: 20)
    socket = TCPSocket.new(target_host, port)
    socket.sync = true
    socket.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)
    socket.setsockopt(Socket::SOL_SOCKET, Socket::SO_KEEPALIVE, 1)
    logger.info("[ws/vnc] tcp_connected tenant=#{tenant_id} vm=#{vm_id} target=#{target_host}:#{port}")

    reader = Thread.new do
      loop do
        chunk = socket.readpartial(16_384)
        ws.send(chunk.force_encoding(Encoding::BINARY))
      end
    rescue EOFError, IOError, SystemCallError
      ws.close
    end

    ws.on :message do |event|
      data = event.data
      socket.write(data.is_a?(String) ? data.b : data.to_s.b)
    rescue IOError, SystemCallError
      ws.close
    end

    ws.on :close do |_event|
      socket.close rescue nil
      reader.kill
    end

    ws.rack_response
  rescue Auth::ApiKeyAuth::AuthenticationError, Auth::ApiKeyAuth::PermissionError => e
    halt 401, Oj.dump(error: e.message)
  rescue Hypervisor::VirshAdapter::CommandError => e
    halt 422, Oj.dump(error: e.message)
  rescue StandardError => e
    halt 500, Oj.dump(error: "VNC tunnel init failed: #{e.message}")
  end

  get '/health' do
    Oj.dump(status: 'ok', env: ENV.fetch('APP_ENV', 'development'))
  end

  get '/api/v1/system/host-readiness' do
    authorize!('vm:read')

    disk_dir = ENV.fetch('VM_DISK_DIR', '/var/lib/libvirt/images')
    checks = []

    libvirt_sock = '/var/run/libvirt/libvirt-sock'
    checks << check_item(
      name: 'libvirt_socket',
      ok: File.socket?(libvirt_sock),
      details: "path=#{libvirt_sock}"
    )

    checks << check_item(
      name: 'kvm_device',
      ok: File.exist?('/dev/kvm') && File.readable?('/dev/kvm'),
      details: 'path=/dev/kvm readable'
    )

    checks << check_item(
      name: 'vm_disk_dir',
      ok: Dir.exist?(disk_dir) && File.writable?(disk_dir),
      details: "path=#{disk_dir} writable"
    )

    virsh_out, virsh_ok = Open3.capture2e('virsh', '--connect', ENV.fetch('HYPERVISOR_URI', 'qemu:///system'), 'list', '--all')
    checks << check_item(
      name: 'virsh_connect',
      ok: virsh_ok.success?,
      details: virsh_ok.success? ? 'virsh connection ok' : virsh_out.strip
    )

    overall = checks.all? { |c| c[:ok] }
    status(overall ? 200 : 503)
    Oj.dump(data: { overall_ready: overall, checks: checks })
  end

  get '/api/v1/system/usage' do
    authorize!('vm:read')

    nodeinfo_out, _ = Open3.capture2e('virsh', '--connect', ENV.fetch('HYPERVISOR_URI', 'qemu:///system'), 'nodeinfo')
    cpu_total = nodeinfo_out[/CPU\(s\):\s+(\d+)/, 1].to_i
    mem_total_mb = (nodeinfo_out[/Memory size:\s+(\d+)\s+KiB/, 1].to_i / 1024.0).round

    disk_dir = ENV.fetch('VM_DISK_DIR', '/var/lib/libvirt/images')
    df_out, _ = Open3.capture2e('df', '-k', disk_dir)
    df_line = df_out.split("\n")[1].to_s
    cols = df_line.split(/\s+/)
    disk_total_gb = (cols[1].to_i / 1024.0 / 1024.0).round(1)
    disk_free_gb = (cols[3].to_i / 1024.0 / 1024.0).round(1)

    vm_ids = DB[:tenant_vms].where(tenant_id: @tenant_id).select_map(:vm_id)
    adapter = Hypervisor::VirshAdapter.new
    details = vm_ids.map { |id| adapter.vm_details(id) rescue nil }.compact
    running = details.count { |d| d[:state].to_s.downcase.include?('running') }
    alloc_vcpus = details.sum { |d| d[:vcpus].to_i }
    alloc_mem_mb = details.sum { |d| d[:memory_mb].to_i }
    alloc_disk_gb = details.sum do |d|
      Array(d[:disks]).sum do |disk|
        next 0 unless disk[:device] == 'disk' && File.file?(disk[:source])

        File.size(disk[:source]) / 1024.0 / 1024.0 / 1024.0
      end
    end.round(1)

    Oj.dump(data: {
      host: {
        cpu_total: cpu_total,
        memory_total_mb: mem_total_mb,
        disk_total_gb: disk_total_gb,
        disk_free_gb: disk_free_gb
      },
      tenant: {
        vm_total: vm_ids.length,
        vm_running: running,
        alloc_vcpus: alloc_vcpus,
        alloc_memory_mb: alloc_mem_mb,
        alloc_disk_gb: alloc_disk_gb
      }
    })
  end

  # Agent protocol module
  post '/api/v1/agents/register' do
    authorize!('vm:write')
    body = json_body
    node_name = sanitize_id(body.fetch('node_name'))
    token = "agt-#{SecureRandom.hex(18)}"
    now = Time.now.utc

    DB[:agents].insert_conflict(target: :node_name, update: {
      token: token,
      status: 'online',
      version: body['version'],
      last_seen_ip: request.ip,
      capabilities_json: Oj.dump(Array(body['capabilities'])),
      last_seen_at: now,
      updated_at: now
    }).insert(
      node_name: node_name,
      token: token,
      status: 'online',
      version: body['version'],
      last_seen_ip: request.ip,
      capabilities_json: Oj.dump(Array(body['capabilities'])),
      last_seen_at: now,
      created_at: now,
      updated_at: now
    )

    AuditLogger.log!(tenant_id: @tenant_id, actor_role: @current_role, action: 'agent_register', resource_type: 'agent', resource_id: node_name, status: 'success', message: 'agent registered', metadata: { node_name: node_name })
    Oj.dump(data: { node_name: node_name, token: token })
  end

  post '/api/v1/agents/heartbeat' do
    body = json_body
    token = body.fetch('token').to_s
    agent = DB[:agents].where(token: token).first
    halt 401, Oj.dump(error: 'Invalid agent token') unless agent

    now = Time.now.utc
    DB[:agents].where(id: agent[:id]).update(
      status: 'online',
      version: body['version'] || agent[:version],
      last_seen_ip: request.ip,
      capabilities_json: Oj.dump(Array(body['capabilities'] || Oj.load(agent[:capabilities_json]))),
      last_seen_at: now,
      updated_at: now
    )

    Oj.dump(data: { status: 'ok', node_name: agent[:node_name], last_seen_at: now })
  end

  get '/api/v1/agents' do
    authorize!('vm:read')
    rows = DB[:agents].order(Sequel.desc(:last_seen_at)).all
    Oj.dump(data: rows)
  end

  # Marketplace module
  get '/api/v1/marketplace/apps' do
    authorize!('vm:read')
    Oj.dump(data: DB[:app_catalog].order(:name).all)
  end

  post '/api/v1/marketplace/apps/:slug/install' do
    authorize!('vm:write')
    slug = sanitize_id(params[:slug])
    app = DB[:app_catalog].where(slug: slug).first
    halt 404, Oj.dump(error: 'App not found') unless app

    idem_key = request.env['HTTP_IDEMPOTENCY_KEY'].to_s
    code, body = IdempotencyStore.with_key(tenant_id: @tenant_id, scope: 'marketplace_install', key: idem_key) do
      now = Time.now.utc
      install_id = DB[:app_installs].insert(
        tenant_id: @tenant_id,
        app_slug: slug,
        status: 'queued',
        created_at: now,
        updated_at: now
      )

      jid = AppMarketplaceJob.perform_async('install', @tenant_id, slug, install_id, @current_role)
      DB[:app_installs].where(id: install_id).update(sidekiq_jid: jid, updated_at: Time.now.utc)

      AuditLogger.log!(tenant_id: @tenant_id, actor_role: @current_role, action: 'marketplace_install', resource_type: 'app', resource_id: slug, status: 'queued', message: 'install queued', metadata: { install_id: install_id, job_id: jid })
      [202, { data: { install_id: install_id, job_id: jid, status: 'queued' } }]
    end
    status code
    Oj.dump(body)
  end

  get '/api/v1/marketplace/installs' do
    authorize!('vm:read')
    rows = DB[:app_installs].where(tenant_id: @tenant_id).order(Sequel.desc(:id)).limit(limit_param).all
    Oj.dump(data: rows)
  end

  # Backup engine module
  post '/api/v1/backups/policies' do
    authorize!('vm:write')
    body = json_body
    now = Time.now.utc
    policy_id = DB[:backup_policies].insert(
      tenant_id: @tenant_id,
      name: body.fetch('name').to_s,
      target_type: body.fetch('target_type', 'vm').to_s,
      target_id: sanitize_id(body.fetch('target_id')),
      schedule_cron: body.fetch('schedule_cron', '0 3 * * *').to_s,
      retention_count: Integer(body.fetch('retention_count', 7)),
      destination: body.fetch('destination', 'local').to_s,
      status: 'active',
      created_at: now,
      updated_at: now
    )
    Oj.dump(data: { policy_id: policy_id })
  end

  get '/api/v1/backups/policies' do
    authorize!('vm:read')
    Oj.dump(data: DB[:backup_policies].where(tenant_id: @tenant_id).order(Sequel.desc(:id)).all)
  end

  post '/api/v1/backups/run' do
    authorize!('vm:operate')
    body = json_body
    vm_id = sanitize_id(body.fetch('vm_id'))
    assert_tenant_vm!(vm_id)

    idem_key = request.env['HTTP_IDEMPOTENCY_KEY'].to_s
    code, response = IdempotencyStore.with_key(tenant_id: @tenant_id, scope: 'backup_run', key: idem_key) do
      now = Time.now.utc
      run_id = DB[:backup_runs].insert(
        policy_id: body['policy_id'],
        tenant_id: @tenant_id,
        vm_id: vm_id,
        status: 'queued',
        triggered_by: @current_role,
        created_at: now,
        updated_at: now
      )

      jid = BackupRunJob.perform_async(run_id, @tenant_id, @current_role)
      DB[:backup_runs].where(id: run_id).update(sidekiq_jid: jid, updated_at: Time.now.utc)

      AuditLogger.log!(tenant_id: @tenant_id, actor_role: @current_role, action: 'backup_run', resource_type: 'vm', resource_id: vm_id, status: 'queued', message: 'backup queued', metadata: { run_id: run_id, job_id: jid })
      [202, { data: { run_id: run_id, job_id: jid, status: 'queued' } }]
    end
    status code
    Oj.dump(response)
  end

  get '/api/v1/backups/runs' do
    authorize!('vm:read')
    rows = DB[:backup_runs].where(tenant_id: @tenant_id).order(Sequel.desc(:id)).limit(limit_param).all
    Oj.dump(data: rows)
  end

  get '/api/v1/vms' do
    authorize!('vm:read')
    data = DB[:tenant_vms].where(tenant_id: @tenant_id).select_map(:vm_id)
    Oj.dump(data: data)
  end

  get '/api/v1/vms/details' do
    authorize!('vm:read')
    adapter = Hypervisor::VirshAdapter.new
    rows = DB[:tenant_vms].where(tenant_id: @tenant_id).select_map(:vm_id).map do |vm_id|
      begin
        adapter.vm_details(vm_id)
      rescue Hypervisor::VirshAdapter::CommandError
        { id: vm_id, state: 'unknown', vcpus: nil, memory_mb: nil, boot_order: [], boot_primary: nil, iso_path: nil, network_mode: nil, network_source: nil }
      end
    end
    Oj.dump(data: rows)
  end

  post '/api/v1/vms' do
    authorize!('vm:write')
    body = json_body
    vm_id = sanitize_id(body.fetch('id'))
    network_mode = body.fetch('network_mode', 'network').to_s
    halt 400, Oj.dump(error: 'network_mode must be network or bridge') unless %w[network bridge].include?(network_mode)
    network_source_key = network_mode == 'bridge' ? 'bridge' : 'network'
    network_source = sanitize_id(body.fetch(network_source_key, body.fetch('network', 'default')))
    payload = {
      'vcpus' => Integer(body.fetch('vcpus')),
      'memory_mb' => Integer(body.fetch('memory_mb')),
      'disk_gb' => Integer(body.fetch('disk_gb')),
      'iso_path' => body['iso_path'],
      'network_mode' => network_mode,
      'network_source' => network_source
    }

    idem_key = request.env['HTTP_IDEMPOTENCY_KEY'].to_s
    code, response = IdempotencyStore.with_key(tenant_id: @tenant_id, scope: 'vm_create', key: idem_key) do
      operation_id, jid = enqueue_operation('create', vm_id, payload)
      [202, { status: 'queued', action: 'create', vm_id: vm_id, operation_id: operation_id, job_id: jid }]
    end
    status code
    Oj.dump(response)
  end

  post '/api/v1/vms/:id/attach-iso' do
    authorize!('vm:operate')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    body = json_body
    iso_path = body.fetch('iso_path').to_s
    halt 400, Oj.dump(error: 'iso_path must be provided') if iso_path.strip.empty?
    operation_id, jid = enqueue_operation('attach_iso', vm_id, { 'iso_path' => iso_path })
    status 202
    Oj.dump(status: 'queued', action: 'attach_iso', vm_id: vm_id, operation_id: operation_id, job_id: jid)
  end

  post '/api/v1/vms/:id/detach-iso' do
    authorize!('vm:operate')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    operation_id, jid = enqueue_operation('detach_iso', vm_id, {})
    status 202
    Oj.dump(status: 'queued', action: 'detach_iso', vm_id: vm_id, operation_id: operation_id, job_id: jid)
  end

  post '/api/v1/vms/:id/boot-order' do
    authorize!('vm:operate')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    body = json_body
    primary = body.fetch('primary', 'hd').to_s
    halt 400, Oj.dump(error: "primary must be 'hd' or 'cdrom'") unless %w[hd cdrom].include?(primary)
    operation_id, jid = enqueue_operation('set_boot_order', vm_id, { 'primary' => primary })
    status 202
    Oj.dump(status: 'queued', action: 'set_boot_order', vm_id: vm_id, operation_id: operation_id, job_id: jid)
  end

  post '/api/v1/vms/:id/reconfigure' do
    authorize!('vm:operate')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    body = json_body
    payload = {}
    payload['vcpus'] = Integer(body['vcpus']) if body.key?('vcpus')
    payload['memory_mb'] = Integer(body['memory_mb']) if body.key?('memory_mb')
    payload['disk_gb'] = Integer(body['disk_gb']) if body.key?('disk_gb')
    halt 400, Oj.dump(error: 'at least one of vcpus,memory_mb,disk_gb required') if payload.empty?
    operation_id, jid = enqueue_operation('reconfigure_offline', vm_id, payload)
    status 202
    Oj.dump(status: 'queued', action: 'reconfigure_offline', vm_id: vm_id, operation_id: operation_id, job_id: jid)
  end

  post '/api/v1/vms/:id/disks' do
    authorize!('vm:operate')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    body = json_body
    size_gb = Integer(body.fetch('size_gb'))
    halt 400, Oj.dump(error: 'size_gb must be >= 1') if size_gb < 1
    operation_id, jid = enqueue_operation('add_host_disk_offline', vm_id, { 'size_gb' => size_gb })
    status 202
    Oj.dump(status: 'queued', action: 'add_host_disk_offline', vm_id: vm_id, operation_id: operation_id, job_id: jid)
  end

  delete '/api/v1/vms/:id' do
    authorize!('vm:write')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    operation_id, jid = enqueue_operation('destroy', vm_id)
    status 202
    Oj.dump(status: 'queued', action: 'destroy', vm_id: vm_id, operation_id: operation_id, job_id: jid)
  end

  post '/api/v1/vms/:id/start' do
    authorize!('vm:operate')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    operation_id, jid = enqueue_operation('start', vm_id)
    status 202
    Oj.dump(status: 'queued', action: 'start', vm_id: vm_id, operation_id: operation_id, job_id: jid)
  end

  post '/api/v1/vms/:id/stop' do
    authorize!('vm:operate')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    operation_id, jid = enqueue_operation('stop', vm_id)
    status 202
    Oj.dump(status: 'queued', action: 'stop', vm_id: vm_id, operation_id: operation_id, job_id: jid)
  end

  get '/api/v1/vms/:id/snapshots' do
    authorize!('snapshot:manage')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    snapshots = Hypervisor::VirshAdapter.new.snapshot_list(vm_id)
    Oj.dump(data: snapshots)
  end

  post '/api/v1/vms/:id/snapshots' do
    authorize!('snapshot:manage')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    body = json_body
    snapshot_name = sanitize_id(body.fetch('snapshot_name'))
    operation_id, jid = enqueue_operation('snapshot_create', vm_id, { 'snapshot_name' => snapshot_name })
    status 202
    Oj.dump(status: 'queued', action: 'snapshot_create', vm_id: vm_id, snapshot_name: snapshot_name, operation_id: operation_id, job_id: jid)
  end

  post '/api/v1/vms/:id/snapshots/:snapshot_name/revert' do
    authorize!('snapshot:manage')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    snapshot_name = sanitize_id(params[:snapshot_name])
    operation_id, jid = enqueue_operation('snapshot_revert', vm_id, { 'snapshot_name' => snapshot_name })
    status 202
    Oj.dump(status: 'queued', action: 'snapshot_revert', vm_id: vm_id, snapshot_name: snapshot_name, operation_id: operation_id, job_id: jid)
  end

  get '/api/v1/vms/:id/vnc' do
    authorize!('vm:read')
    vm_id = sanitize_id(params[:id])
    assert_tenant_vm!(vm_id)
    display = Hypervisor::VirshAdapter.new.vnc_display(vm_id)
    halt 404, Oj.dump(error: 'VNC display not available for VM') if display.nil?
    host = request.host.to_s.empty? ? 'localhost' : request.host.to_s
    port = display.start_with?(':') ? (5900 + display[1..].to_i) : nil
    Oj.dump(data: { vm_id: vm_id, host: host, display: display, port: port, url: port ? "vnc://#{host}:#{port}" : nil })
  rescue Hypervisor::VirshAdapter::CommandError => e
    message = e.message.to_s
    if message.include?('Domain is not running')
      halt 409, Oj.dump(error: 'VM is not running; start VM before requesting VNC')
    end
    halt 500, Oj.dump(error: "VNC lookup failed: #{message}")
  end

  get '/api/v1/iso-library' do
    authorize!('vm:read')
    iso_dir = ENV.fetch('ISO_LIBRARY_DIR', '/var/lib/libvirt/boot')
    FileUtils.mkdir_p(iso_dir)
    entries = Dir.children(iso_dir).sort.select { |n| n.downcase.end_with?('.iso') }
    rows = entries.map do |name|
      path = File.join(iso_dir, name)
      stat = File.stat(path)
      { name: name, path: path, size_bytes: stat.size, mtime: stat.mtime.utc }
    end
    Oj.dump(data: rows)
  end

  post '/api/v1/iso-library/import' do
    authorize!('vm:write')
    body = json_body
    source_path = body.fetch('source_path').to_s
    halt 400, Oj.dump(error: 'source_path must be provided') if source_path.strip.empty?
    halt 400, Oj.dump(error: 'source_path must point to .iso file') unless source_path.downcase.end_with?('.iso')
    halt 404, Oj.dump(error: 'source_path not found') unless File.file?(source_path)

    iso_dir = ENV.fetch('ISO_LIBRARY_DIR', '/var/lib/libvirt/boot')
    FileUtils.mkdir_p(iso_dir)
    filename = File.basename(source_path).gsub(/[^a-zA-Z0-9_.-]/, '_')
    target_path = File.join(iso_dir, filename)
    FileUtils.cp(source_path, target_path)
    stat = File.stat(target_path)
    status 201
    Oj.dump(data: { name: filename, path: target_path, size_bytes: stat.size, imported_from: source_path })
  end

  get '/api/v1/jobs' do
    authorize!('vm:read')
    limit = limit_param
    per_source_limit = [[limit * 2, 25].max, 100].min

    vm_jobs = DB[:vm_operations].where(tenant_id: @tenant_id).order(Sequel.desc(:id)).limit(per_source_limit).all.map do |r|
      {
        id: "vm-#{r[:id]}",
        source: 'vm',
        action: r[:action],
        target: r[:vm_id],
        status: r[:status],
        sidekiq_jid: r[:sidekiq_jid],
        started_at: r[:started_at],
        finished_at: r[:finished_at],
        created_at: r[:created_at]
      }
    end

    app_jobs = DB[:app_installs].where(tenant_id: @tenant_id).order(Sequel.desc(:id)).limit(per_source_limit).all.map do |r|
      {
        id: "app-#{r[:id]}",
        source: 'marketplace',
        action: 'install',
        target: r[:app_slug],
        status: r[:status],
        sidekiq_jid: r[:sidekiq_jid],
        started_at: r[:started_at],
        finished_at: r[:finished_at],
        created_at: r[:created_at]
      }
    end

    backup_jobs = DB[:backup_runs].where(tenant_id: @tenant_id).order(Sequel.desc(:id)).limit(per_source_limit).all.map do |r|
      {
        id: "backup-#{r[:id]}",
        source: 'backup',
        action: 'run',
        target: r[:vm_id],
        status: r[:status],
        sidekiq_jid: r[:sidekiq_jid],
        started_at: r[:started_at],
        finished_at: r[:finished_at],
        created_at: r[:created_at]
      }
    end

    rows = (vm_jobs + app_jobs + backup_jobs).sort_by { |x| x[:created_at] || Time.at(0) }.reverse.first(limit)
    Oj.dump(data: rows)
  end

  get '/api/v1/jobs/:id' do
    authorize!('vm:read')
    row = DB[:vm_operations].where(id: Integer(params[:id]), tenant_id: @tenant_id).first
    halt 404, Oj.dump(error: 'Operation not found') unless row

    Oj.dump(data: row)
  end

  get '/api/v1/audit-logs' do
    authorize!('vm:read')
    rows = DB[:audit_logs].where(tenant_id: @tenant_id).order(Sequel.desc(:id)).limit(limit_param).all
    Oj.dump(data: rows)
  end

  private

  def json_body
    raw = request.body.read
    return {} if raw.to_s.strip.empty?

    Oj.load(raw)
  rescue Oj::ParseError
    halt 400, Oj.dump(error: 'Invalid JSON body')
  end

  def authorize!(permission)
    Auth::ApiKeyAuth.new.authorize!(@current_role, permission)
  rescue Auth::ApiKeyAuth::PermissionError => e
    halt 403, Oj.dump(error: e.message)
  end

  def sanitize_id(value)
    value.to_s.gsub(/[^a-zA-Z0-9_.:-]/, '')
  end

  def assert_tenant_vm!(vm_id)
    exists = DB[:tenant_vms].where(tenant_id: @tenant_id, vm_id: vm_id).count.positive?
    halt 404, Oj.dump(error: 'VM not found in tenant scope') unless exists
  end

  def enqueue_operation(action, vm_id, payload = {})
    operation_id = OperationStore.create!(
      tenant_id: @tenant_id,
      vm_id: vm_id,
      action: action,
      payload: payload,
      actor_role: @current_role
    )
    jid = VmLifecycleJob.perform_async(action, vm_id, payload, operation_id, @tenant_id, @current_role)
    OperationStore.attach_sidekiq_jid!(operation_id, jid)
    AuditLogger.log!(
      tenant_id: @tenant_id,
      actor_role: @current_role,
      action: action,
      resource_type: 'vm',
      resource_id: vm_id,
      status: 'queued',
      message: "#{action} queued",
      metadata: payload.merge('operation_id' => operation_id, 'job_id' => jid)
    )
    [operation_id, jid]
  end

  def limit_param
    limit = Integer(params.fetch('limit', 25))
    [[limit, 1].max, 100].min
  rescue ArgumentError
    25
  end

  def check_item(name:, ok:, details:)
    {
      name: name,
      ok: ok,
      details: details
    }
  end

  def default_gateway_ip
    out, status = Open3.capture2e('sh', '-c', "ip route | awk '/default/ {print $3; exit}'")
    return '172.17.0.1' unless status.success?

    ip = out.to_s.strip
    ip.empty? ? '172.17.0.1' : ip
  end
end
