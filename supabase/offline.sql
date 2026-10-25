-- Run once in your Supabase SQL editor. No anonymous/public table policies.
create table if not exists public.dl_devices (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  code text not null unique check (code ~ '^[0-9]{6}$'),
  public_key jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.dl_transfers (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.dl_devices(id),
  receiver_id uuid not null references public.dl_devices(id),
  sender_code text not null,
  object_path text not null unique,
  envelope jsonb not null,
  byte_count bigint not null check (byte_count between 20 and 26222592),
  kind text not null check (kind in ('file','text')),
  status text not null default 'uploading' check (status in ('uploading','ready','downloaded','rejected')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists dl_inbox on public.dl_transfers(receiver_id,status,expires_at);
create index if not exists dl_expiry on public.dl_transfers(expires_at);
create table if not exists public.dl_rate_limits (
  bucket text primary key,
  hits integer not null,
  created_at timestamptz not null default now()
);
alter table public.dl_devices enable row level security;
alter table public.dl_transfers enable row level security;
alter table public.dl_rate_limits enable row level security;
revoke all on public.dl_devices, public.dl_transfers, public.dl_rate_limits from anon, authenticated;
grant all on public.dl_devices, public.dl_transfers, public.dl_rate_limits to service_role;

create or replace function public.dl_take_limit(bucket_key text, maximum integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare result integer;
begin
  insert into dl_rate_limits(bucket,hits) values(bucket_key,1)
  on conflict(bucket) do update set hits=dl_rate_limits.hits+1
  where dl_rate_limits.hits < maximum returning hits into result;
  return result is not null;
end; $$;

create or replace function public.dl_register(token_hash_value text, public_key_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare device dl_devices; candidate text; attempt integer;
begin
  -- Serialize retries for this private token; never allow a public key replacement.
  perform pg_advisory_xact_lock(hashtextextended(token_hash_value, 0));
  select * into device from dl_devices where token_hash=token_hash_value;
  if found then
    if device.public_key <> public_key_value then raise exception 'Device key mismatch'; end if;
    return jsonb_build_object('code',device.code);
  end if;
  if not dl_take_limit('new-devices:' || (now() at time zone 'utc')::date::text,500) then raise exception 'Registration limit reached'; end if;
  for attempt in 1..30 loop
    candidate := (100000 + floor(random()*900000))::integer::text;
    begin
      insert into dl_devices(token_hash,code,public_key) values(token_hash_value,candidate,public_key_value) returning * into device;
      return jsonb_build_object('code',device.code);
    exception when unique_violation then null;
    end;
  end loop;
  raise exception 'Code allocation failed';
end; $$;

create or replace function public.dl_reserve(sender uuid, receiver_code text, encryption jsonb, byte_count bigint, item_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare recipient dl_devices; source dl_devices; item_id uuid := gen_random_uuid(); day_key text := (now() at time zone 'utc')::date::text;
begin
  select * into source from dl_devices where id=sender;
  if not found then raise exception 'Sender unavailable'; end if;
  -- Serialize inbox reservations so concurrent uploads cannot exceed the quota.
  select * into recipient from dl_devices where code=receiver_code for update;
  if not found or recipient.id=sender then raise exception 'Recipient unavailable'; end if;
  if (select count(*) from dl_transfers where receiver_id=recipient.id and expires_at>now() and status in ('uploading','ready')) >= 50 then raise exception 'Inbox full'; end if;
  if not dl_take_limit('uploads:' || sender::text || ':' || day_key,20) then raise exception 'Sender daily limit reached'; end if;
  if not dl_take_limit('uploads-global:' || day_key,100) then raise exception 'Project daily limit reached'; end if;
  insert into dl_transfers(id,sender_id,receiver_id,sender_code,object_path,envelope,byte_count,kind)
    values(item_id,sender,recipient.id,source.code,item_id::text || '/payload.bin',encryption,byte_count,item_kind);
  return jsonb_build_object('id',item_id,'object_path',item_id::text || '/payload.bin');
end; $$;

revoke all on function public.dl_take_limit(text,integer) from public, anon, authenticated;
revoke all on function public.dl_register(text,jsonb) from public, anon, authenticated;
revoke all on function public.dl_reserve(uuid,text,jsonb,bigint,text) from public, anon, authenticated;
grant execute on function public.dl_take_limit(text,integer) to service_role;
grant execute on function public.dl_register(text,jsonb) to service_role;
grant execute on function public.dl_reserve(uuid,text,jsonb,bigint,text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('swooshit-later','swooshit-later',false,26222592,array['application/octet-stream'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- Do not add public storage policies. The backend issues short-lived signed URLs.
