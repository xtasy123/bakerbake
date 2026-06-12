-- Creates a paid POS order atomically in one database request.

create or replace function public.create_pos_order(
  p_order jsonb,
  p_items jsonb,
  p_actor_username text,
  p_actor_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_counter bigint;
  v_order_id bigint;
  v_request_id text := nullif(p_order->>'request_id', '');
  v_items jsonb;
begin
  if v_request_id is not null then
    select * into v_order
    from public.orders
    where request_id = v_request_id
    limit 1;

    if found then
      select coalesce(jsonb_agg(to_jsonb(item) order by item.id), '[]'::jsonb)
      into v_items
      from public.order_items item
      where item.order_id = v_order.id;

      select greatest(
        coalesce((value #>> '{}')::bigint, 1001),
        v_order.id + 1
      )
      into v_counter
      from public.app_state
      where key = 'order_counter';

      return jsonb_build_object(
        'order', to_jsonb(v_order) || jsonb_build_object(
          'order_items', v_items,
          'void_requests', '[]'::jsonb
        ),
        'orderCounter', v_counter,
        'duplicate', true
      );
    end if;
  end if;

  insert into public.app_state (key, value)
  values ('order_counter', '1001'::jsonb)
  on conflict (key) do nothing;

  select greatest(
    coalesce((value #>> '{}')::bigint, 1001),
    coalesce((select max(id) + 1 from public.orders), 1001)
  )
  into v_counter
  from public.app_state
  where key = 'order_counter'
  for update;

  -- Recheck after acquiring the counter lock so simultaneous retries remain idempotent.
  if v_request_id is not null then
    select * into v_order
    from public.orders
    where request_id = v_request_id
    limit 1;

    if found then
      select coalesce(jsonb_agg(to_jsonb(item) order by item.id), '[]'::jsonb)
      into v_items
      from public.order_items item
      where item.order_id = v_order.id;

      return jsonb_build_object(
        'order', to_jsonb(v_order) || jsonb_build_object(
          'order_items', v_items,
          'void_requests', '[]'::jsonb
        ),
        'orderCounter', greatest(v_counter, v_order.id + 1),
        'duplicate', true
      );
    end if;
  end if;

  v_order_id := v_counter;

  insert into public.orders (
    id,
    request_id,
    customer_name,
    cashier,
    status,
    total,
    payment_method,
    payment,
    items,
    payload,
    created_at,
    completed_at,
    updated_at
  )
  values (
    v_order_id,
    v_request_id,
    coalesce(nullif(p_order->>'customer_name', ''), 'Walk-in'),
    coalesce(nullif(p_order->>'cashier', ''), 'Unknown'),
    'pending',
    coalesce((p_order->>'total')::numeric, 0),
    coalesce(nullif(p_order->>'payment_method', ''), 'cash'),
    coalesce(p_order->'payment', 'null'::jsonb),
    '[]'::jsonb,
    '{}'::jsonb,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    null,
    now()
  )
  returning * into v_order;

  insert into public.order_items (
    order_id,
    product_id,
    product_name,
    variant_key,
    size_label,
    quantity,
    unit_price
  )
  select
    v_order_id,
    nullif(item->>'product_id', '')::bigint,
    coalesce(nullif(item->>'product_name', ''), 'Unknown item'),
    nullif(item->>'variant_key', ''),
    nullif(item->>'size_label', ''),
    greatest(coalesce((item->>'quantity')::integer, 1), 1),
    greatest(coalesce((item->>'unit_price')::numeric, 0), 0)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) item;

  update public.app_state
  set value = to_jsonb(v_order_id + 1),
      updated_at = now()
  where key = 'order_counter';

  insert into public.audit_logs (
    actor_username,
    actor_role,
    action,
    entity_type,
    entity_id,
    details
  )
  values (
    p_actor_username,
    p_actor_role,
    'order.created',
    'order',
    v_order_id::text,
    jsonb_build_object(
      'total', v_order.total,
      'paymentMethod', v_order.payment_method
    )
  );

  select coalesce(jsonb_agg(to_jsonb(item) order by item.id), '[]'::jsonb)
  into v_items
  from public.order_items item
  where item.order_id = v_order_id;

  return jsonb_build_object(
    'order', to_jsonb(v_order) || jsonb_build_object(
      'order_items', v_items,
      'void_requests', '[]'::jsonb
    ),
    'orderCounter', v_order_id + 1,
    'duplicate', false
  );
end;
$$;

revoke all on function public.create_pos_order(jsonb, jsonb, text, text) from public;
grant execute on function public.create_pos_order(jsonb, jsonb, text, text) to service_role;
