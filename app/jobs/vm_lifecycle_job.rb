# frozen_string_literal: true

class VmLifecycleJob
  include Sidekiq::Job

  def perform(action, domain_id, payload = {}, operation_id = nil, tenant_id = nil, actor_role = 'system')
    adapter = Hypervisor::VirshAdapter.new
    vm_id = sanitize_id(domain_id)
    tenant = sanitize_id(tenant_id)

    OperationStore.mark_running!(operation_id) if operation_id

    case action
    when 'create'
      adapter.create_domain(
        name: vm_id,
        vcpus: payload.fetch('vcpus'),
        memory_mb: payload.fetch('memory_mb'),
        disk_gb: payload.fetch('disk_gb'),
        iso_path: payload['iso_path'],
        network_mode: payload.fetch('network_mode', 'network'),
        network_source: payload.fetch('network_source', payload.fetch('network', 'default')),
        vlan_id: payload['vlan_id']
      )
      adapter.set_autostart(vm_id, payload['start_at_boot']) if payload.key?('start_at_boot')
      if payload['snapshot_on_create'] && payload['snapshot_on_create_name'].to_s != ''
        adapter.snapshot_create(vm_id, payload['snapshot_on_create_name'].to_s)
      end
      DB[:tenant_vms].insert_conflict(target: %i[tenant_id vm_id], update: { vm_id: Sequel[:excluded][:vm_id] })
                    .insert(tenant_id: tenant, vm_id: vm_id, created_at: Time.now.utc)
    when 'start'
      adapter.start(vm_id)
    when 'stop'
      adapter.stop(vm_id)
    when 'destroy'
      adapter.destroy_domain(vm_id)
      DB[:tenant_vms].where(tenant_id: tenant, vm_id: vm_id).delete
    when 'purge'
      adapter.purge_domain(vm_id)
      DB[:tenant_vms].where(tenant_id: tenant, vm_id: vm_id).delete
      DB[:vm_profiles].where(tenant_id: tenant, vm_id: vm_id).delete
      DB[:backup_runs].where(tenant_id: tenant, vm_id: vm_id).delete
    when 'snapshot_create'
      adapter.snapshot_create(vm_id, payload.fetch('snapshot_name'))
    when 'snapshot_revert'
      adapter.snapshot_revert(vm_id, payload.fetch('snapshot_name'))
    when 'snapshot_delete'
      adapter.snapshot_delete(vm_id, payload.fetch('snapshot_name'))
    when 'attach_iso'
      adapter.attach_iso(vm_id, payload.fetch('iso_path'))
    when 'detach_iso'
      adapter.detach_iso(vm_id)
    when 'clone'
      source_vm_id = sanitize_id(payload.fetch('source_vm_id', vm_id))
      adapter.clone_domain(source_id: source_vm_id, target_id: vm_id)
      DB[:tenant_vms].insert_conflict(target: %i[tenant_id vm_id], update: { vm_id: Sequel[:excluded][:vm_id] })
                    .insert(tenant_id: tenant, vm_id: vm_id, created_at: Time.now.utc)
      source_profile = DB[:vm_profiles].where(tenant_id: tenant, vm_id: source_vm_id).first
      if source_profile
        now = Time.now.utc
        DB[:vm_profiles].insert_conflict(target: %i[tenant_id vm_id], update: { config_json: source_profile[:config_json], updated_at: now })
                        .insert(tenant_id: tenant, vm_id: vm_id, config_json: source_profile[:config_json], created_at: now, updated_at: now)
      end
    when 'migrate'
      adapter.migrate_domain(
        vm_id,
        destination_uri: payload.fetch('destination_uri'),
        live: payload.fetch('live', true),
        copy_storage: payload.fetch('copy_storage', false)
      )
    when 'backup_restore'
      backup_run_id = Integer(payload.fetch('backup_run_id'))
      backup_run = DB[:backup_runs].where(id: backup_run_id, tenant_id: tenant, vm_id: vm_id).first
      raise ArgumentError, 'Backup run not found for VM' unless backup_run
      raise ArgumentError, 'Backup run has no backup_path' if backup_run[:backup_path].to_s.strip.empty?
      adapter.restore_primary_disk_from_backup(vm_id, backup_run[:backup_path].to_s)
    when 'set_boot_order'
      adapter.set_boot_order(vm_id, payload.fetch('primary', 'hd'))
    when 'reconfigure_offline'
      adapter.reconfigure_offline(
        vm_id,
        vcpus: payload['vcpus'],
        memory_mb: payload['memory_mb'],
        disk_gb: payload['disk_gb']
      )
    when 'add_host_disk_offline'
      adapter.add_host_disk_offline(
        vm_id,
        size_gb: payload.fetch('size_gb')
      )
    else
      raise ArgumentError, "Unsupported action: #{action}"
    end

    OperationStore.mark_success!(operation_id) if operation_id
    AuditLogger.log!(
      tenant_id: tenant,
      actor_role: actor_role,
      action: action,
      resource_type: 'vm',
      resource_id: vm_id,
      status: 'success',
      message: "#{action} completed",
      metadata: payload
    )
  rescue StandardError => e
    OperationStore.mark_failed!(operation_id, e.message) if operation_id
    AuditLogger.log!(
      tenant_id: tenant,
      actor_role: actor_role,
      action: action,
      resource_type: 'vm',
      resource_id: vm_id,
      status: 'failed',
      message: e.message,
      metadata: payload
    )
    raise
  end

  private

  def sanitize_id(value)
    value.to_s.gsub(/[^a-zA-Z0-9_.:-]/, '')
  end
end
