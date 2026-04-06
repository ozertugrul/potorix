# frozen_string_literal: true

require 'open3'
require 'shellwords'
require 'tempfile'
require 'fileutils'
require 'cgi'
require 'nokogiri'

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

    def create_domain(name:, vcpus:, memory_mb:, disk_gb:, iso_path: nil, network_mode: 'network', network_source: 'default', vlan_id: nil)
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
        network_source: network_source,
        vlan_id: vlan_id
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

    def purge_domain(domain_id)
      vm = clean(domain_id)
      destroy_domain(vm)
      purge_disk_artifacts(vm)
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
      elsif msg.include?('Cannot get interface MTU on') && msg.include?(': No such device')
        migrate_missing_bridge_to_default_network(clean(domain_id))
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

    def snapshot_delete(domain_id, snapshot_name)
      run('snapshot-delete', clean(domain_id), clean(snapshot_name), '--metadata')
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
      doc = load_domain_xml(vm)
      os = doc.at_xpath('/domain/os')
      raise CommandError, 'Invalid domain XML: missing <os>' unless os

      os.xpath('boot').remove
      os.add_child(doc.create_element('boot', 'dev' => primary_dev))
      os.add_child(doc.create_element('boot', 'dev' => secondary))
      redefine_xml(doc)
      { primary: primary_dev }
    end

    def set_autostart(domain_id, enabled)
      vm = clean(domain_id)
      if enabled
        run('autostart', vm)
      else
        run('autostart', vm, '--disable')
      end
      { autostart: !!enabled }
    end

    def vm_details(domain_id)
      vm = clean(domain_id)
      doc = load_domain_xml(vm)
      state = run('domstate', vm).to_s.strip
      boot_order = doc.xpath('/domain/os/boot').map { |n| n['dev'].to_s }.reject(&:empty?)
      iso_path = doc.at_xpath("/domain/devices/disk[@device='cdrom']/source")&.[]('file')
      iface = doc.at_xpath('/domain/devices/interface[1]')
      network_mode = iface&.[]('type')
      source_node = iface&.at_xpath('./source')
      network_source = if network_mode == 'network'
                         source_node&.[]('network')
                       elsif network_mode == 'bridge'
                         source_node&.[]('bridge')
                       end
      memory_node = doc.at_xpath('/domain/memory')
      memory_unit = memory_node&.[]('unit').to_s
      memory_val = memory_node&.text.to_s.to_i
      memory_kib = convert_memory_to_kib(memory_val, memory_unit)
      memory_mb = (memory_kib / 1024.0).round
      vcpus = doc.at_xpath('/domain/vcpu')&.text.to_s.to_i
      disks = doc.xpath('/domain/devices/disk').filter_map do |disk|
        device = disk['device'].to_s
        next nil unless %w[disk cdrom].include?(device)
        source = disk.at_xpath('./source')&.[]('file')
        target = disk.at_xpath('./target')&.[]('dev')
        next nil if source.to_s.empty? || target.to_s.empty?
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
      doc = load_domain_xml(vm)
      changed = false

      if vcpus
        vcpu_node = doc.at_xpath('/domain/vcpu')
        raise CommandError, 'Invalid domain XML: missing <vcpu>' unless vcpu_node
        vcpu_node.content = Integer(vcpus).to_s
        changed = true
      end
      if memory_mb
        kib = Integer(memory_mb) * 1024
        memory_node = doc.at_xpath('/domain/memory')
        current_node = doc.at_xpath('/domain/currentMemory')
        raise CommandError, 'Invalid domain XML: missing <memory>' unless memory_node
        memory_node['unit'] = 'KiB'
        memory_node.content = kib.to_s
        if current_node
          current_node['unit'] = 'KiB'
          current_node.content = kib.to_s
        end
        changed = true
      end
      redefine_xml(doc) if changed

      if disk_gb
        disk_path = primary_disk_path_from_doc(doc)
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

    def clone_domain(source_id:, target_id:)
      source_vm = clean(source_id)
      target_vm = clean(target_id)
      raise CommandError, 'Target VM ID is required' if target_vm.empty?
      ensure_domain_stopped!(source_vm)
      raise CommandError, "Target VM already exists: #{target_vm}" if list_domains.include?(target_vm)

      doc = load_domain_xml(source_vm)
      source_disk = primary_disk_path_from_doc(doc)
      raise CommandError, 'Source primary disk not found (vda)' if source_disk.to_s.empty?

      disk_dir = ENV.fetch('VM_DISK_DIR', '/var/lib/libvirt/images')
      FileUtils.mkdir_p(disk_dir)
      target_disk = File.join(disk_dir, "#{target_vm}.qcow2")
      run('qemu-img', 'convert', '-O', 'qcow2', source_disk, target_disk)

      cloned_doc = doc.dup
      name_node = cloned_doc.at_xpath('/domain/name')
      name_node.content = target_vm if name_node
      cloned_doc.at_xpath('/domain/uuid')&.remove
      cloned_doc.xpath('/domain/devices/interface/mac').remove
      replace_primary_disk_source_in_doc(cloned_doc, target_disk)
      redefine_xml(cloned_doc)

      { source_id: source_vm, target_id: target_vm, disk_path: target_disk }
    rescue CommandError
      FileUtils.rm_f(target_disk) if defined?(target_disk) && target_disk
      raise
    end

    def migrate_domain(domain_id, destination_uri:, live: true, copy_storage: false)
      vm = clean(domain_id)
      dest = destination_uri.to_s.strip
      raise CommandError, 'destination_uri is required' if dest.empty?

      args = ['migrate']
      args << '--live' if live
      args << '--persistent'
      args << '--copy-storage-all' if copy_storage
      args << vm
      args << dest
      run(*args)
      { vm_id: vm, destination_uri: dest, live: live, copy_storage: copy_storage }
    end

    def primary_disk_path(domain_id)
      vm = clean(domain_id)
      doc = load_domain_xml(vm)
      path = primary_disk_path_from_doc(doc)
      raise CommandError, 'Primary disk path not found (vda)' if path.to_s.empty?

      path
    end

    def restore_primary_disk_from_backup(domain_id, backup_path)
      vm = clean(domain_id)
      src = backup_path.to_s
      raise CommandError, 'backup_path is required' if src.strip.empty?
      raise CommandError, "backup image not found: #{src}" unless File.file?(src)
      ensure_domain_stopped!(vm)
      target_disk = primary_disk_path(vm)
      run('qemu-img', 'convert', '-O', 'qcow2', src, target_disk)
      { vm_id: vm, restored_from: src, target_disk: target_disk }
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

    def domain_xml(name:, vcpus:, memory_mb:, disk_path:, iso_path:, network_mode:, network_source:, vlan_id: nil)
      install_cdrom = iso_path.to_s.empty? ? '' : <<~XML
        <disk type='file' device='cdrom'>
          <driver name='qemu' type='raw'/>
          <source file='#{xml_escape(iso_path)}'/>
          <target dev='sdb' bus='sata'/>
          <readonly/>
        </disk>
      XML

      vlan_tag = if vlan_id.to_s.strip.empty?
                   ''
                 else
                   "<vlan><tag id='#{Integer(vlan_id)}'/></vlan>"
                 end

      network_interface = if network_mode.to_s == 'bridge'
                            <<~XML
                              <interface type='bridge'>
                                <source bridge='#{clean(network_source)}'/>
                                #{vlan_tag}
                                <model type='virtio'/>
                              </interface>
                            XML
                          else
                            <<~XML
                              <interface type='network'>
                                <source network='#{clean(network_source)}'/>
                                #{vlan_tag}
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
            <video>
              <model type='virtio' vram='16384' heads='1' primary='yes'/>
            </video>
            <sound model='ich9'/>
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

    def migrate_missing_bridge_to_default_network(domain_id)
      xml = run('dumpxml', clean(domain_id))
      migrated = xml.gsub(
        /<interface type='bridge'>\s*(<mac address='[^']+'\/>\s*)?<source bridge='[^']+'\/>\s*<model type='([^']+)'\/>/m
      ) do
        mac = Regexp.last_match(1).to_s
        model = Regexp.last_match(2).to_s
        "<interface type='network'>\n      #{mac}<source network='default'/>\n      <model type='#{model.empty? ? 'virtio' : model}'/>"
      end
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

    def purge_disk_artifacts(domain_id)
      vm = clean(domain_id)
      disk_dir = ENV.fetch('VM_DISK_DIR', '/var/lib/libvirt/images')
      Dir.glob(File.join(disk_dir, "#{vm}*")).each do |path|
        next unless File.file?(path)

        FileUtils.rm_f(path)
      end
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

    def primary_disk_path_from_doc(doc)
      disk = doc.at_xpath("/domain/devices/disk[@device='disk'][target[@dev='vda']]")
      disk&.at_xpath('./source')&.[]('file')
    end

    def next_virtio_disk_target(xml)
      doc = Nokogiri::XML(xml) { |cfg| cfg.strict.noblanks }
      used = doc.xpath('/domain/devices/disk/target').map { |t| t['dev'].to_s }.select { |d| d.match?(/^vd[a-z]$/) }
      ('b'..'z').each do |suffix|
        dev = "vd#{suffix}"
        return dev unless used.include?(dev)
      end
      raise CommandError, 'No free virtio disk target available'
    end

    def replace_primary_disk_source_in_doc(doc, new_source)
      disk = doc.at_xpath("/domain/devices/disk[@device='disk'][target[@dev='vda']]")
      raise CommandError, 'Primary disk not found for clone' unless disk
      source = disk.at_xpath('./source')
      unless source
        source = doc.create_element('source')
        disk.add_child(source)
      end
      source['file'] = new_source
    end

    def load_domain_xml(vm)
      xml = run('dumpxml', vm)
      Nokogiri::XML(xml) { |cfg| cfg.strict.noblanks }
    rescue Nokogiri::XML::SyntaxError => e
      raise CommandError, "Invalid domain XML for #{vm}: #{e.message}"
    end

    def redefine_xml(doc)
      with_tempfile(doc.to_xml) { |path| run('define', path) }
    end

    def convert_memory_to_kib(value, unit)
      case unit.to_s
      when 'KiB', '' then value
      when 'MiB' then value * 1024
      when 'GiB' then value * 1024 * 1024
      else
        value
      end
    end
  end
end
