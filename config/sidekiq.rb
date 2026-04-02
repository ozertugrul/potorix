# frozen_string_literal: true

require_relative 'boot'
require_relative 'database'

# Explicit loads keep startup predictable in Sinatra + Sidekiq mode.
require_relative '../app/services/hypervisor/virsh_adapter'
require_relative '../app/services/realtime_stream'
require_relative '../app/services/operation_store'
require_relative '../app/services/audit_logger'
require_relative '../app/jobs/vm_lifecycle_job'
require_relative '../app/jobs/app_marketplace_job'
require_relative '../app/jobs/backup_run_job'

Sidekiq.configure_server do |config|
  config.redis = { url: ENV.fetch('REDIS_URL') }
end

Sidekiq.configure_client do |config|
  config.redis = { url: ENV.fetch('REDIS_URL') }
end
