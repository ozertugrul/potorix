# frozen_string_literal: true

class SchedulerJob
  include Sidekiq::Job

  def perform
    now = Time.now.utc
    policies = DB[:backup_policies].where(status: 'active').all
    policies.each do |policy|
      next unless due_now?(policy[:schedule_cron].to_s, now)
      next unless acquire_policy_lock(policy[:id], now)

      enqueue_backup_run(policy, now)
    end
  end

  private

  def due_now?(cron_expr, now)
    cron = Fugit::Cron.parse(cron_expr)
    return false unless cron

    prev = cron.previous_time(now + 1)
    return false unless prev

    prev.to_utc.strftime('%Y-%m-%d %H:%M') == now.strftime('%Y-%m-%d %H:%M')
  rescue StandardError
    false
  end

  def acquire_policy_lock(policy_id, now)
    key = "potorix:scheduler:policy:#{policy_id}:#{now.strftime('%Y%m%d%H%M')}"
    redis.set(key, '1', nx: true, ex: 180).to_s == 'OK'
  rescue StandardError
    false
  end

  def enqueue_backup_run(policy, now)
    vm_id = policy[:target_id].to_s
    return if vm_id.empty?

    run_id = DB[:backup_runs].insert(
      policy_id: policy[:id],
      tenant_id: policy[:tenant_id],
      vm_id: vm_id,
      status: 'queued',
      triggered_by: 'scheduler',
      created_at: now,
      updated_at: now
    )
    jid = BackupRunJob.perform_async(run_id, policy[:tenant_id], 'scheduler')
    DB[:backup_runs].where(id: run_id).update(sidekiq_jid: jid, updated_at: Time.now.utc)
  rescue StandardError => e
    AuditLogger.log!(
      tenant_id: policy[:tenant_id].to_s,
      actor_role: 'system',
      action: 'backup_schedule',
      resource_type: 'vm',
      resource_id: vm_id,
      status: 'failed',
      message: e.message,
      metadata: { policy_id: policy[:id] }
    )
  end

  def redis
    @redis ||= Redis.new(url: ENV.fetch('REDIS_URL'))
  end
end
