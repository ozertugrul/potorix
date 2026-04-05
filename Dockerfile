FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM ruby:3.3-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  pkg-config \
  libpq-dev \
  libvirt-dev \
  libvirt-clients \
  qemu-utils \
  novnc \
  websockify \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY Gemfile /app/Gemfile
RUN bundle config set without 'development test' && bundle install

COPY . /app
COPY --from=frontend-builder /app/public /app/public

CMD ["bundle", "exec", "puma", "-C", "config/puma.rb"]
