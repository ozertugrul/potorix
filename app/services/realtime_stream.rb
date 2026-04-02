# frozen_string_literal: true

require 'securerandom'

class RealtimeStream
  CHANNEL = 'potorix:events'

  class << self
    def publish!(event_type:, tenant_id:, severity: 'info', actor: {}, resource: {}, data: {}, trace: {})
      envelope = {
        event_id: SecureRandom.uuid,
        event_type: event_type,
        occurred_at: Time.now.utc.iso8601,
        tenant_id: tenant_id,
        severity: severity,
        actor: actor,
        resource: resource,
        trace: trace,
        data: data
      }
      redis.publish(CHANNEL, Oj.dump(envelope))
    end

    def redis
      @redis ||= Redis.new(url: ENV.fetch('REDIS_URL'))
    end
  end
end
