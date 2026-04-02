# frozen_string_literal: true

class AuditLogger
  class << self
    def log!(tenant_id:, actor_role:, action:, resource_type:, resource_id:, status:, message:, metadata: {})
      id = DB[:audit_logs].insert(
        tenant_id: tenant_id,
        actor_role: actor_role,
        action: action,
        resource_type: resource_type,
        resource_id: resource_id,
        status: status,
        message: message,
        metadata_json: Oj.dump(metadata),
        created_at: Time.now.utc
      )
      RealtimeStream.publish!(
        event_type: 'audit.logged',
        tenant_id: tenant_id,
        severity: status == 'failed' ? 'error' : 'info',
        actor: { role: actor_role },
        resource: { type: resource_type, id: resource_id },
        trace: { audit_id: id },
        data: {
          action: action,
          status: status,
          message: message,
          metadata: metadata
        }
      )
      id
    end
  end
end
