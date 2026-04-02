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

CMD ["bundle", "exec", "puma", "-C", "config/puma.rb"]
