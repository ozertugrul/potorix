# frozen_string_literal: true

class AppMarketplaceJob
  include Sidekiq::Job

  def perform(action, tenant_id, app_slug, install_id, actor_role = 'system')
    now = Time.now.utc
    DB[:app_installs].where(id: install_id, tenant_id: tenant_id).update(status: 'running', started_at: now, updated_at: now)

    case action
    when 'install'
      sleep 1
      DB[:app_installs].where(id: install_id, tenant_id: tenant_id).update(
        status: 'success',
        message: 'app installed',
        finished_at: Time.now.utc,
        updated_at: Time.now.utc
      )
      AuditLogger.log!(
        tenant_id: tenant_id,
        actor_role: actor_role,
        action: 'marketplace_install',
        resource_type: 'app',
        resource_id: app_slug,
        status: 'success',
        message: "#{app_slug} installed",
        metadata: { install_id: install_id }
      )
    else
      raise ArgumentError, "Unsupported marketplace action: #{action}"
    end
  rescue StandardError => e
    DB[:app_installs].where(id: install_id, tenant_id: tenant_id).update(
      status: 'failed',
      error_message: e.message,
      finished_at: Time.now.utc,
      updated_at: Time.now.utc
    )
    AuditLogger.log!(
      tenant_id: tenant_id,
      actor_role: actor_role,
      action: 'marketplace_install',
      resource_type: 'app',
      resource_id: app_slug,
      status: 'failed',
      message: e.message,
      metadata: { install_id: install_id }
    )
    raise
  end
end
