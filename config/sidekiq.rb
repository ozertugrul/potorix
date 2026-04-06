# frozen_string_literal: true

require_relative 'boot'
require_relative 'database'
require 'sidekiq/cron/job'
require 'fugit'

# Explicit loads keep startup predictable in Sinatra + Sidekiq mode.
require_relative '../app/services/hypervisor/virsh_adapter'
require_relative '../app/services/realtime_stream'
require_relative '../app/services/operation_store'
require_relative '../app/services/audit_logger'
require_relative '../app/jobs/vm_lifecycle_job'
require_relative '../app/jobs/app_marketplace_job'
require_relative '../app/jobs/backup_run_job'
require_relative '../app/jobs/metrics_collector_job'
require_relative '../app/jobs/scheduler_job'

Sidekiq.configure_server do |config|
  config.redis = { url: ENV.fetch('REDIS_URL') }
  config.on(:startup) do
    MetricsCollectorJob.perform_in(5)
    Sidekiq::Cron::Job.create(
      name: 'backup-policy-scheduler',
      cron: ENV.fetch('BACKUP_SCHEDULER_CRON', '* * * * *'),
      class: 'SchedulerJob'
    )
  end
end

Sidekiq.configure_client do |config|
  config.redis = { url: ENV.fetch('REDIS_URL') }
end
