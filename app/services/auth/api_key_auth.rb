# frozen_string_literal: true

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
      role = @token_map[token]
      raise AuthenticationError, 'Invalid API key' unless role

      role
    end

    def authorize!(role, permission)
      return if ROLE_PERMISSIONS.fetch(role, []).include?(permission)

      raise PermissionError, "Role #{role} lacks #{permission}"
    end

    private

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
