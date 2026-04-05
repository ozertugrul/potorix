# frozen_string_literal: true

def connect_with_retry
  attempts = Integer(ENV.fetch('DB_CONNECT_RETRIES', 30))
  delay = Float(ENV.fetch('DB_CONNECT_DELAY', 2))
  tries = 0

  begin
    tries += 1
    Sequel.connect(ENV.fetch('DATABASE_URL'))
  rescue Sequel::DatabaseConnectionError
    raise if tries >= attempts

    sleep(delay)
    retry
  end
end

DB = connect_with_retry

def ensure_table(name, &block)
  return if DB.table_exists?(name)

  begin
    DB.create_table(name, &block)
  rescue Sequel::DatabaseError
    raise unless DB.table_exists?(name)
  end
end

def ensure_index(table, columns, name:)
  return if DB.indexes(table).key?(name)

  begin
    DB.add_index(table, columns, name: name)
  rescue Sequel::DatabaseError
    raise unless DB.indexes(table).key?(name)
  end
end

ensure_table(:idempotency_keys) do
  primary_key :id
  String :tenant_id, null: false
  String :scope, null: false
  String :idempotency_key, null: false
  String :status, null: false
  Integer :response_code
  Text :response_json
  DateTime :created_at, null: false
  DateTime :updated_at, null: false
  index %i[tenant_id scope idempotency_key], unique: true
end

ensure_table(:tenant_vms) do
  primary_key :id
  String :tenant_id, null: false
  String :vm_id, null: false
  DateTime :created_at, null: false
  index %i[tenant_id vm_id], unique: true
end

ensure_table(:vm_profiles) do
  primary_key :id
  String :tenant_id, null: false
  String :vm_id, null: false
  Text :config_json, null: false, default: '{}'
  DateTime :created_at, null: false
  DateTime :updated_at, null: false
  index %i[tenant_id vm_id], unique: true
end

ensure_table(:vm_operations) do
  primary_key :id
  String :tenant_id, null: false
  String :vm_id, null: false
  String :action, null: false
  String :status, null: false
  String :sidekiq_jid
  Text :payload_json, null: false, default: '{}'
  Text :error_message
  DateTime :created_at, null: false
  DateTime :updated_at, null: false
  DateTime :started_at
  DateTime :finished_at
  index :tenant_id
  index :status
end
ensure_index(:vm_operations, %i[tenant_id id], name: :vm_operations_tenant_id_id_idx)

ensure_table(:audit_logs) do
  primary_key :id
  String :tenant_id, null: false
  String :actor_role, null: false
  String :action, null: false
  String :resource_type, null: false
  String :resource_id, null: false
  String :status, null: false
  Text :message, null: false
  Text :metadata_json, null: false, default: '{}'
  DateTime :created_at, null: false
  index :tenant_id
end
ensure_index(:audit_logs, %i[tenant_id id], name: :audit_logs_tenant_id_id_idx)

ensure_table(:agents) do
  primary_key :id
  String :node_name, null: false
  String :token, null: false
  String :status, null: false, default: 'offline'
  String :version
  String :last_seen_ip
  Text :capabilities_json, null: false, default: '[]'
  DateTime :last_seen_at
  DateTime :created_at, null: false
  DateTime :updated_at, null: false
  index :node_name, unique: true
  index :token, unique: true
end

ensure_table(:app_catalog) do
  primary_key :id
  String :slug, null: false
  String :name, null: false
  String :version, null: false
  Text :description, null: false
  String :source, null: false, default: 'builtin'
  DateTime :created_at, null: false
  DateTime :updated_at, null: false
  index :slug, unique: true
end

now = Time.now.utc
[
  { slug: 'openresty', name: 'OpenResty', version: '1.27.1', description: 'High performance web platform', source: 'builtin' },
  { slug: 'mysql', name: 'MySQL', version: '8.4', description: 'Relational database server', source: 'builtin' },
  { slug: 'redis', name: 'Redis', version: '7.2', description: 'In-memory key-value store', source: 'builtin' }
].each do |row|
  DB[:app_catalog].insert_conflict(target: :slug, update: { updated_at: now }).insert(row.merge(created_at: now, updated_at: now))
end

ensure_table(:app_installs) do
  primary_key :id
  String :tenant_id, null: false
  String :app_slug, null: false
  String :status, null: false
  String :sidekiq_jid
  Text :message
  Text :error_message
  DateTime :started_at
  DateTime :finished_at
  DateTime :created_at, null: false
  DateTime :updated_at, null: false
  index :tenant_id
  index :status
end
ensure_index(:app_installs, %i[tenant_id id], name: :app_installs_tenant_id_id_idx)

ensure_table(:backup_policies) do
  primary_key :id
  String :tenant_id, null: false
  String :name, null: false
  String :target_type, null: false
  String :target_id, null: false
  String :schedule_cron, null: false
  Integer :retention_count, null: false, default: 7
  String :destination, null: false, default: 'local'
  String :status, null: false, default: 'active'
  DateTime :created_at, null: false
  DateTime :updated_at, null: false
  index :tenant_id
end

ensure_table(:backup_runs) do
  primary_key :id
  Integer :policy_id
  String :tenant_id, null: false
  String :vm_id, null: false
  String :status, null: false
  String :triggered_by, null: false
  String :sidekiq_jid
  Integer :size_bytes
  String :checksum
  Text :message
  Text :error_message
  DateTime :started_at
  DateTime :finished_at
  DateTime :created_at, null: false
  DateTime :updated_at, null: false
  index :tenant_id
  index :status
end
ensure_index(:backup_runs, %i[tenant_id id], name: :backup_runs_tenant_id_id_idx)
