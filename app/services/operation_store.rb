# frozen_string_literal: true

class OperationStore
  class << self
    def create!(tenant_id:, vm_id:, action:, payload:, sidekiq_jid: nil, actor_role: 'system')
      now = Time.now.utc
      id = DB[:vm_operations].insert(
        tenant_id: tenant_id,
        vm_id: vm_id,
        action: action,
        status: 'queued',
        sidekiq_jid: sidekiq_jid,
        payload_json: Oj.dump(payload),
        created_at: now,
        updated_at: now
      )
      publish(
        event_type: 'job.queued',
        operation_id: id,
        tenant_id: tenant_id,
        vm_id: vm_id,
        action: action,
        status: 'queued',
        actor_role: actor_role,
        payload: payload,
        occurred_at: now
      )
      id
    end

    def mark_running!(id)
      now = Time.now.utc
      op = row!(id)
      DB[:vm_operations].where(id: id).update(status: 'running', started_at: now, updated_at: now)
      publish(
        event_type: 'job.running',
        operation_id: id,
        tenant_id: op[:tenant_id],
        vm_id: op[:vm_id],
        action: op[:action],
        status: 'running',
        actor_role: 'system',
        payload: parse_json(op[:payload_json]),
        occurred_at: now,
        sidekiq_jid: op[:sidekiq_jid],
        duration_ms: ms_between(op[:created_at], now)
      )
    end

    def mark_success!(id)
      now = Time.now.utc
      op = row!(id)
      DB[:vm_operations].where(id: id).update(status: 'success', finished_at: now, updated_at: now)
      publish(
        event_type: 'job.succeeded',
        operation_id: id,
        tenant_id: op[:tenant_id],
        vm_id: op[:vm_id],
        action: op[:action],
        status: 'success',
        actor_role: 'system',
        payload: parse_json(op[:payload_json]),
        occurred_at: now,
        sidekiq_jid: op[:sidekiq_jid],
        duration_ms: ms_between(op[:started_at] || op[:created_at], now)
      )
    end

    def mark_failed!(id, error)
      now = Time.now.utc
      op = row!(id)
      DB[:vm_operations].where(id: id).update(
        status: 'failed',
        error_message: error.to_s,
        finished_at: now,
        updated_at: now
      )
      publish(
        event_type: 'job.failed',
        operation_id: id,
        tenant_id: op[:tenant_id],
        vm_id: op[:vm_id],
        action: op[:action],
        status: 'failed',
        actor_role: 'system',
        payload: parse_json(op[:payload_json]),
        occurred_at: now,
        sidekiq_jid: op[:sidekiq_jid],
        duration_ms: ms_between(op[:started_at] || op[:created_at], now),
        error: error.to_s
      )
    end

    def attach_sidekiq_jid!(id, jid)
      DB[:vm_operations].where(id: id).update(sidekiq_jid: jid, updated_at: Time.now.utc)
    end

    private

    def row!(id)
      row = DB[:vm_operations].where(id: id).first
      raise ArgumentError, "Operation not found: #{id}" unless row

      row
    end

    def parse_json(raw)
      Oj.load(raw.to_s)
    rescue Oj::ParseError
      {}
    end

    def ms_between(from_time, to_time)
      return nil unless from_time && to_time

      ((to_time.to_f - from_time.to_f) * 1000).to_i
    end

    def publish(event_type:, operation_id:, tenant_id:, vm_id:, action:, status:, actor_role:, payload:, occurred_at:, sidekiq_jid: nil, duration_ms: nil, error: nil)
      RealtimeStream.publish!(
        event_type: event_type,
        tenant_id: tenant_id,
        severity: status == 'failed' ? 'error' : 'info',
        actor: { role: actor_role },
        resource: { type: 'vm', id: vm_id },
        trace: { operation_id: operation_id, sidekiq_jid: sidekiq_jid },
        data: {
          action: action,
          status: status,
          payload: payload,
          duration_ms: duration_ms,
          occurred_at: occurred_at.iso8601,
          error: error
        }
      )
    end
  end
end
