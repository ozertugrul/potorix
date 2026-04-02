# frozen_string_literal: true

require 'bundler/setup'
Bundler.require(:default, ENV.fetch('APP_ENV', 'development').to_sym)

require 'dotenv/load'

Oj.default_options = {
  mode: :compat,
  time_format: :ruby,
  use_to_json: true
}
