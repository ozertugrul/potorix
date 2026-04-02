# frozen_string_literal: true

class IdempotencyStore
  class << self
    def with_key(tenant_id:, scope:, key:)
      return yield if key.to_s.strip.empty?

      now = Time.now.utc
      begin
        DB[:idempotency_keys].insert(
          tenant_id: tenant_id,
          scope: scope,
          idempotency_key: key,
          status: 'processing',
          created_at: now,
          updated_at: now
        )
      rescue Sequel::UniqueConstraintViolation
        existing = DB[:idempotency_keys].where(tenant_id: tenant_id, scope: scope, idempotency_key: key).first
        if existing && existing[:status] == 'completed' && existing[:response_json]
          return [existing[:response_code] || 200, Oj.load(existing[:response_json])]
        end
        raise StandardError, 'Duplicate in-flight idempotent request'
      end

      response = yield
      DB[:idempotency_keys].where(tenant_id: tenant_id, scope: scope, idempotency_key: key).update(
        status: 'completed',
        response_code: response[0],
        response_json: Oj.dump(response[1]),
        updated_at: Time.now.utc
      )
      response
    end
  end
end
