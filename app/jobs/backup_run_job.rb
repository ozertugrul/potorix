# frozen_string_literal: true

require 'securerandom'

class BackupRunJob
  include Sidekiq::Job

  def perform(run_id, tenant_id, actor_role = 'system')
    now = Time.now.utc
    run = DB[:backup_runs].where(id: run_id, tenant_id: tenant_id).first
    raise ArgumentError, 'Backup run not found' unless run

    DB[:backup_runs].where(id: run_id).update(status: 'running', started_at: now, updated_at: now)

    # Placeholder backup engine; in next phase replace with real snapshot/export/upload pipeline.
    sleep 1
    size_bytes = rand(50_000_000..200_000_000)
    checksum = SecureRandom.hex(16)

    DB[:backup_runs].where(id: run_id).update(
      status: 'success',
      size_bytes: size_bytes,
      checksum: checksum,
      message: 'backup completed',
      finished_at: Time.now.utc,
      updated_at: Time.now.utc
    )

    AuditLogger.log!(
      tenant_id: tenant_id,
      actor_role: actor_role,
      action: 'backup_run',
      resource_type: 'vm',
      resource_id: run[:vm_id],
      status: 'success',
      message: "backup completed for #{run[:vm_id]}",
      metadata: { run_id: run_id, size_bytes: size_bytes, checksum: checksum }
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
end
