# frozen_string_literal: true

require 'open3'
require 'shellwords'
require 'tempfile'
require 'fileutils'
require 'cgi'

module Hypervisor
  class VirshAdapter
    class CommandError < StandardError; end

    def initialize(uri: ENV.fetch('HYPERVISOR_URI', 'qemu:///system'))
      @uri = uri
    end

    def list_domains
      output = run('list', '--all', '--name')
      output.split("\n").map(&:strip).reject(&:empty?)
    end

    def create_domain(name:, vcpus:, memory_mb:, disk_gb:, iso_path: nil, network_mode: 'network', network_source: 'default')
      disk_dir = ENV.fetch('VM_DISK_DIR', '/var/lib/libvirt/images')
      FileUtils.mkdir_p(disk_dir)
      disk_path = File.join(disk_dir, "#{name}.qcow2")
      run('qemu-img', 'create', '-f', 'qcow2', disk_path, "#{Integer(disk_gb)}G")

      xml = domain_xml(
        name: name,
        vcpus: Integer(vcpus),
        memory_mb: Integer(memory_mb),
        disk_path: disk_path,
        iso_path: iso_path,
        network_mode: network_mode,
        network_source: network_source
      )

      with_tempfile(xml) { |path| run('define', path) }
      { name: name, disk_path: disk_path }
    end

    def destroy_domain(domain_id)
      vm = clean(domain_id)
      destroy(vm)
      cleanup_snapshots(vm)
      undefine_with_fallback(vm)
    end

    def start(domain_id)
      run('start', clean(domain_id))
    rescue CommandError => e
      msg = e.message.to_s
      if msg.include?("network 'default' is not active")
        ensure_network_active('default')
        run('start', clean(domain_id))
      elsif msg.include?("Cannot get interface MTU on 'default': No such device")
        migrate_legacy_default_bridge_interface(clean(domain_id))
        ensure_network_active('default')
        run('start', clean(domain_id))
      elsif msg.include?('Domain is already active')
        'already-active'
      else
        raise
      end
    end

    def stop(domain_id)
      run('destroy', clean(domain_id))
    rescue CommandError => e
      msg = e.message.to_s
      if msg.include?('domain is not running') || msg.include?('domain is not active')
        'already-stopped'
      else
        raise
      end
    end

    def destroy(domain_id)
      run('destroy', clean(domain_id))
    rescue CommandError => e
      msg = e.message.to_s
      if msg.include?('domain is not running') || msg.include?('domain is not active')
        'already-stopped'
      elsif msg.include?('failed to get domain') || msg.include?('Domain not found')
        'already-absent'
      else
        raise
      end
    end

    def snapshot_create(domain_id, snapshot_name)
      run('snapshot-create-as', clean(domain_id), clean(snapshot_name), '--disk-only', '--atomic')
    end

    def snapshot_list(domain_id)
      output = run('snapshot-list', clean(domain_id), '--name')
      output.split("\n").map(&:strip).reject(&:empty?)
    end

    def snapshot_revert(domain_id, snapshot_name)
      run('snapshot-revert', clean(domain_id), clean(snapshot_name))
    end

    def attach_iso(domain_id, iso_path)
      run('change-media', clean(domain_id), 'sdb', '--insert', iso_path.to_s, '--config')
      set_boot_order(clean(domain_id), 'cdrom')
    rescue CommandError => e
      message = e.message.to_s
      if message.include?('No disk found whose source path or target is sdb')
        run('attach-disk', clean(domain_id), iso_path.to_s, 'sdb', '--type', 'cdrom', '--mode', 'readonly', '--config')
        set_boot_order(clean(domain_id), 'cdrom')
      elsif message.include?("already has media")
        'already-has-media'
      else
        raise
      end
    end

    def detach_iso(domain_id)
      run('change-media', clean(domain_id), 'sdb', '--eject', '--config')
      set_boot_order(clean(domain_id), 'hd')
    rescue CommandError => e
      if e.message.to_s.include?('No disk found whose source path or target is sdb')
        run('detach-disk', clean(domain_id), 'sdb', '--config')
        set_boot_order(clean(domain_id), 'hd')
      else
        raise
      end
    end

    def set_boot_order(domain_id, primary)
      vm = clean(domain_id)
      primary_dev = primary.to_s == 'cdrom' ? 'cdrom' : 'hd'
      secondary = primary_dev == 'cdrom' ? 'hd' : 'cdrom'
      xml = run('dumpxml', vm)
      boots = ["<boot dev='#{primary_dev}'/>", "<boot dev='#{secondary}'/>"].join("\n    ")

      updated = if xml.match?(%r{<os>.*?</os>}m)
                  xml.sub(%r{<os>(.*?)</os>}m) do
                    os_block = Regexp.last_match(1)
                    cleaned = os_block.gsub(%r{\s*<boot dev='[^']+'/>\s*}m, "\n    ")
                    "<os>#{cleaned.rstrip}\n    #{boots}\n  </os>"
                  end
                else
                  xml
                end
      with_tempfile(updated) { |path| run('define', path) }
      { primary: primary_dev }
    end

    def vm_details(domain_id)
      vm = clean(domain_id)
      xml = run('dumpxml', vm)
      state = run('domstate', vm).to_s.strip
      boot_order = xml.scan(/<boot dev='([^']+)'\/>/).flatten
      iso_path = xml[/<disk[^>]*device='cdrom'[^>]*>.*?<source file='([^']+)'\/>/m, 1]
      network_mode = xml[/<interface type='(network|bridge)'>/, 1]
      network_source = if network_mode == 'network'
                         xml[/<interface type='network'>.*?<source network='([^']+)'/m, 1]
                       elsif network_mode == 'bridge'
                         xml[/<interface type='bridge'>.*?<source bridge='([^']+)'/m, 1]
                       end
      memory_kib = xml[/<memory unit='KiB'>(\d+)<\/memory>/, 1].to_i
      memory_mb = (memory_kib / 1024.0).round
      vcpus = xml[/<vcpu(?:\s[^>]*)?>(\d+)<\/vcpu>/, 1].to_i
      disks = xml.scan(%r{<disk[^>]*device='(disk|cdrom)'[^>]*>.*?<source file='([^']+)'\/>.*?<target dev='([^']+)'[^>]*/>.*?</disk>}m).map do |(device, source, target)|
        { device: device, source: source, target: target }
      end
      {
        id: vm,
        state: state,
        vcpus: vcpus,
        memory_mb: memory_mb,
        boot_order: boot_order,
        boot_primary: boot_order.first,
        iso_path: iso_path,
        network_mode: network_mode,
        network_source: network_source,
        disks: disks
      }
    end

    def reconfigure_offline(domain_id, vcpus: nil, memory_mb: nil, disk_gb: nil)
      vm = clean(domain_id)
      ensure_domain_stopped!(vm)
      xml = run('dumpxml', vm)
      updated = xml.dup

      if vcpus
        updated.sub!(%r{<vcpu(?:\s[^>]*)?>\d+</vcpu>}, "<vcpu>#{Integer(vcpus)}</vcpu>")
      end
      if memory_mb
        kib = Integer(memory_mb) * 1024
        updated.sub!(%r{<memory unit='KiB'>\d+</memory>}, "<memory unit='KiB'>#{kib}</memory>")
        updated.sub!(%r{<currentMemory unit='KiB'>\d+</currentMemory>}, "<currentMemory unit='KiB'>#{kib}</currentMemory>")
      end
      with_tempfile(updated) { |path| run('define', path) } if updated != xml

      if disk_gb
        disk_path = primary_disk_path_from_xml(xml)
        raise CommandError, 'Primary disk path not found (vda)' if disk_path.to_s.empty?

        run('qemu-img', 'resize', disk_path, "#{Integer(disk_gb)}G")
      end
      vm_details(vm)
    end

    def add_host_disk_offline(domain_id, size_gb:)
      vm = clean(domain_id)
      ensure_domain_stopped!(vm)
      xml = run('dumpxml', vm)
      target = next_virtio_disk_target(xml)
      disk_dir = ENV.fetch('VM_DISK_DIR', '/var/lib/libvirt/images')
      FileUtils.mkdir_p(disk_dir)
      disk_path = File.join(disk_dir, "#{vm}-#{target}.qcow2")
      run('qemu-img', 'create', '-f', 'qcow2', disk_path, "#{Integer(size_gb)}G")
      run('attach-disk', vm, disk_path, target, '--targetbus', 'virtio', '--subdriver', 'qcow2', '--config')
      { vm_id: vm, disk_path: disk_path, target: target }
    end

    def vnc_display(domain_id)
      output = run('vncdisplay', clean(domain_id)).to_s.strip
      output.empty? ? nil : output
    end

    private

    def run(*args)
      if args.first == 'qemu-img'
        output, status = Open3.capture2e(*args)
      else
        cmd = ['virsh', '--connect', @uri, *args]
        output, status = Open3.capture2e(*cmd)
      end
      raise CommandError, output unless status.success?

      output
    end

    def clean(value)
      value.to_s.gsub(/[^a-zA-Z0-9_.:-]/, '')
    end

    def with_tempfile(content)
      file = Tempfile.new(['potorix-domain', '.xml'])
      file.write(content)
      file.flush
      yield(file.path)
    ensure
      file&.close!
    end

    def domain_xml(name:, vcpus:, memory_mb:, disk_path:, iso_path:, network_mode:, network_source:)
      install_cdrom = iso_path.to_s.empty? ? '' : <<~XML
        <disk type='file' device='cdrom'>
          <driver name='qemu' type='raw'/>
          <source file='#{xml_escape(iso_path)}'/>
          <target dev='sdb' bus='sata'/>
          <readonly/>
        </disk>
      XML

      network_interface = if network_mode.to_s == 'bridge'
                            <<~XML
                              <interface type='bridge'>
                                <source bridge='#{clean(network_source)}'/>
                                <model type='virtio'/>
                              </interface>
                            XML
                          else
                            <<~XML
                              <interface type='network'>
                                <source network='#{clean(network_source)}'/>
                                <model type='virtio'/>
                              </interface>
                            XML
                          end

      boot_order = if iso_path.to_s.empty?
                     "<boot dev='hd'/>"
                   else
                     "<boot dev='cdrom'/>\n        <boot dev='hd'/>"
                   end

      <<~XML
        <domain type='kvm'>
          <name>#{clean(name)}</name>
          <memory unit='MiB'>#{memory_mb}</memory>
          <vcpu>#{vcpus}</vcpu>
          <os>
            <type arch='x86_64' machine='pc-q35-8.2'>hvm</type>
            #{boot_order}
          </os>
          <features>
            <acpi/>
            <apic/>
          </features>
          <cpu mode='host-model'/>
          <devices>
            <emulator>/usr/bin/qemu-system-x86_64</emulator>
            <disk type='file' device='disk'>
              <driver name='qemu' type='qcow2'/>
              <source file='#{disk_path}'/>
              <target dev='vda' bus='virtio'/>
            </disk>
            #{install_cdrom}
            #{network_interface}
            <graphics type='vnc' autoport='yes' listen='0.0.0.0'/>
            <console type='pty'/>
          </devices>
        </domain>
      XML
    end

    def xml_escape(value)
      CGI.escapeHTML(value.to_s)
    end

    def ensure_network_active(network_name)
      state = run('net-info', clean(network_name))
      return if state.include?('Active: yes')

      run('net-start', clean(network_name))
      run('net-autostart', clean(network_name))
    rescue CommandError => e
      msg = e.message.to_s
      return if msg.include?('network is already active')

      raise
    end

    def migrate_legacy_default_bridge_interface(domain_id)
      xml = run('dumpxml', clean(domain_id))
      migrated = xml.gsub(
        /<interface type='bridge'>\s*<mac address='([^']+)'\/>\s*<source bridge='default'\/>\s*<model type='virtio'\/>/m,
        "<interface type='network'>\n      <mac address='\\1'/>\n      <source network='default'/>\n      <model type='virtio'/>"
      )
      return if migrated == xml

      with_tempfile(migrated) { |path| run('define', path) }
    end

    def cleanup_snapshots(domain_id)
      snaps = snapshot_list(domain_id)
      snaps.each do |name|
        run('snapshot-delete', clean(domain_id), clean(name), '--metadata')
      end
    rescue CommandError => e
      msg = e.message.to_s
      raise unless msg.include?('domain has no snapshots')
    end

    def undefine_with_fallback(domain_id)
      run('undefine', clean(domain_id), '--remove-all-storage')
    rescue CommandError => e
      msg = e.message.to_s
      raise unless msg.include?('not managed by libvirt') || msg.include?('cannot delete inactive domain with')

      run('undefine', clean(domain_id), '--snapshots-metadata')
      cleanup_disk_files(domain_id)
    end

    def cleanup_disk_files(domain_id)
      disks = managed_disk_paths(domain_id)
      disks.each { |path| FileUtils.rm_f(path) }

      disk_dir = ENV.fetch('VM_DISK_DIR', '/var/lib/libvirt/images')
      FileUtils.rm_f(File.join(disk_dir, "#{clean(domain_id)}.qcow2"))
    end

    def managed_disk_paths(domain_id)
      out = run('domblklist', clean(domain_id), '--details')
      out.split("\n").filter_map do |line|
        cols = line.split(/\s+/)
        next nil unless cols.length >= 4
        next nil unless cols[1] == 'disk'

        path = cols[3]
        next nil if path == '-'
        next nil unless path.start_with?('/')

        path
      end
    rescue CommandError
      []
    end

    def ensure_domain_stopped!(domain_id)
      state = run('domstate', clean(domain_id)).to_s.downcase
      return if state.include?('shut off') || state.include?('shutoff')

      raise CommandError, 'VM must be powered off for this operation'
    end

    def primary_disk_path_from_xml(xml)
      xml[/<disk[^>]*device='disk'[^>]*>.*?<target dev='vda'[^>]*\/>.*?<source file='([^']+)'\/>.*?<\/disk>/m, 1] ||
        xml[/<disk[^>]*device='disk'[^>]*>.*?<source file='([^']+)'\/>.*?<target dev='vda'[^>]*\/>.*?<\/disk>/m, 1]
    end

    def next_virtio_disk_target(xml)
      used = xml.scan(/<target dev='(vd[a-z])'[^>]*\/>/).flatten
      ('b'..'z').each do |suffix|
        dev = "vd#{suffix}"
        return dev unless used.include?(dev)
      end
      raise CommandError, 'No free virtio disk target available'
    end
  end
end
