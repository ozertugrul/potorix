# frozen_string_literal: true

port ENV.fetch('APP_PORT', 9292)
environment ENV.fetch('APP_ENV', 'development')
threads_count = ENV.fetch('RAILS_MAX_THREADS', 5).to_i
threads threads_count, threads_count
