# frozen_string_literal: true

require 'securerandom'
require 'open3'
require 'fileutils'

class BackupRunJob
  include Sidekiq::Job

  def perform(run_id, tenant_id, actor_role = 'system')
    now = Time.now.utc
    run = DB[:backup_runs].where(id: run_id, tenant_id: tenant_id).first
    raise ArgumentError, 'Backup run not found' unless run

    DB[:backup_runs].where(id: run_id).update(status: 'running', started_at: now, updated_at: now)

    vm_id = run[:vm_id].to_s
    adapter = Hypervisor::VirshAdapter.new
    source_disk = adapter.primary_disk_path(vm_id)
    backup_dir = ENV.fetch('BACKUP_DIR', '/var/lib/libvirt/backups')
    FileUtils.mkdir_p(backup_dir)
    stamp = Time.now.utc.strftime('%Y%m%d%H%M%S')
    backup_path = File.join(backup_dir, "#{vm_id}-#{stamp}.qcow2")
    out, ok = Open3.capture2e('qemu-img', 'convert', '-O', 'qcow2', source_disk, backup_path)
    raise "backup export failed: #{out}" unless ok.success?
    size_bytes = File.size(backup_path)
    checksum, sum_ok = Open3.capture2e('sha256sum', backup_path)
    raise "checksum failed: #{checksum}" unless sum_ok.success?
    checksum = checksum.to_s.split.first.to_s

    DB[:backup_runs].where(id: run_id).update(
      status: 'success',
      size_bytes: size_bytes,
      checksum: checksum,
      backup_path: backup_path,
      message: 'backup completed',
      finished_at: Time.now.utc,
      updated_at: Time.now.utc
    )

    apply_retention!(run[:policy_id], tenant_id, vm_id, backup_dir)

    AuditLogger.log!(
      tenant_id: tenant_id,
      actor_role: actor_role,
      action: 'backup_run',
      resource_type: 'vm',
      resource_id: run[:vm_id],
      status: 'success',
      message: "backup completed for #{run[:vm_id]}",
      metadata: { run_id: run_id, size_bytes: size_bytes, checksum: checksum, backup_path: backup_path }
    )
  rescue StandardError => e
    DB[:backup_runs].where(id: run_id).update(
      status: 'failed',
      error_message: e.message,
      finished_at: Time.now.utc,
      updated_at: Time.now.utc
    )
    AuditLogger.log!(
      tenant_id: tenant_id,
      actor_role: actor_role,
      action: 'backup_run',
      resource_type: 'vm',
      resource_id: run ? run[:vm_id] : 'unknown',
      status: 'failed',
      message: e.message,
      metadata: { run_id: run_id }
    )
    raise
  end

  private

  def apply_retention!(policy_id, tenant_id, vm_id, backup_dir)
    retention = if policy_id
                  DB[:backup_policies].where(id: policy_id, tenant_id: tenant_id).get(:retention_count).to_i
                else
                  Integer(ENV.fetch('BACKUP_RETENTION_COUNT', 7))
                end
    retention = 1 if retention <= 0

    stale = DB[:backup_runs]
            .where(tenant_id: tenant_id, vm_id: vm_id, status: 'success')
            .exclude(backup_path: nil)
            .order(Sequel.desc(:created_at))
            .offset(retention)
            .all

    stale.each do |row|
      path = row[:backup_path].to_s
      next if path.empty?
      next unless path.start_with?(backup_dir.to_s)

      FileUtils.rm_f(path)
      DB[:backup_runs].where(id: row[:id]).update(message: 'pruned by retention', updated_at: Time.now.utc)
    end
  end
end
