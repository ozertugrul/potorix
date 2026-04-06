# frozen_string_literal: true

require 'digest'

module Auth
  class ApiKeyAuth
    PermissionError = Class.new(StandardError)
    AuthenticationError = Class.new(StandardError)

    ROLE_PERMISSIONS = {
      'viewer' => %w[vm:read],
      'operator' => %w[vm:read vm:operate snapshot:manage],
      'admin' => %w[vm:read vm:operate vm:write snapshot:manage]
    }.freeze

    def initialize(tokens: ENV.fetch('AUTH_TOKENS', ''))
      @token_map = parse_tokens(tokens)
    end

    def authenticate!(token)
      role = authenticate_from_db(token) || @token_map[token]
      raise AuthenticationError, 'Invalid API key' unless role

      role
    end

    def authorize!(role, permission)
      return if ROLE_PERMISSIONS.fetch(role, []).include?(permission)

      raise PermissionError, "Role #{role} lacks #{permission}"
    end

    private

    def authenticate_from_db(token)
      return nil if token.to_s.strip.empty?
      return nil unless defined?(DB) && DB.table_exists?(:api_tokens)

      digest = token_digest(token)
      now = Time.now.utc
      row = DB[:api_tokens]
            .where(token_hash: digest, status: 'active')
            .exclude(Sequel.lit('expires_at IS NOT NULL AND expires_at <= ?', now))
            .first
      return nil unless row

      DB[:api_tokens].where(id: row[:id]).update(last_used_at: now, updated_at: now)
      row[:role].to_s
    rescue StandardError
      nil
    end

    def token_digest(token)
      Digest::SHA256.hexdigest(token.to_s)
    end

    def parse_tokens(tokens)
      pairs = tokens.split(',').map(&:strip).reject(&:empty?)
      pairs.each_with_object({}) do |pair, acc|
        role, token = pair.split(':', 2)
        next if role.to_s.empty? || token.to_s.empty?

        acc[token] = role
      end
    end
  end
end
