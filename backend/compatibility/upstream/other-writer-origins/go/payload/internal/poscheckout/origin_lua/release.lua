-- RELEASE — the order DIED (payment failed, or the session expired), so every unit it was holding really did come back.
--
-- ARGV[1] = orderId
-- ARGV[2] = userId, so this order stops counting against that customer's per-sku cap. Empty
-- string when the cap is off. SREM of something that is not a member does nothing, so releasing
-- a line that never counted (a freebie) is harmless.
--
-- A unit goes to one of the same customer's riders (older attempts that gave their unit to a
-- newer one) before it goes back on sale. Passing it moves no counter: it was reserved and stays
-- reserved, only the owner changes. Without a userId there is no riders set to look in.
local orderId = ARGV[1]
local userId = (ARGV[2] ~= nil and ARGV[2] ~= '') and ARGV[2] or nil
local userKey = userId and ('userhold:' .. userId .. ':') or nil
local ridersKey = userId and ('riders:' .. userId .. ':') or nil

-- The dying order's own rider lines go first. Otherwise SPOP below could pick this order as the
-- rider for its own unit and hand the unit to a dead order.
local mine = redis.call('HGETALL', 'rider:' .. orderId)
for i = 1, #mine, 2 do
  if ridersKey then redis.call('SREM', ridersKey .. mine[i+1], orderId .. ':' .. mine[i]) end
end
redis.call('DEL', 'rider:' .. orderId)

-- Members are never cleaned when a rider's line ends some other way, so a popped member can be
-- stale. The HGET is the real check; a stale member is simply dropped.
local function takeRider(sku)
  while true do
    local member = redis.call('SPOP', ridersKey .. sku)
    if not member then return nil end
    local rider, lineno = string.match(member, '^(.+):(.+)$')
    if rider and redis.call('HGET', 'rider:' .. rider, lineno) == sku then
      return rider, lineno
    end
  end
end

local key = 'reservation:' .. orderId
local h = redis.call('HGETALL', key)
local released = 0
local skipped = 0
local passed = 0
for i = 1, #h, 2 do
  local lineno = h[i]
  local sku = h[i+1]
  local rider, riderLine
  if ridersKey then rider, riderLine = takeRider(sku) end
  if rider then
    redis.call('HDEL', 'rider:' .. rider, riderLine)
    redis.call('HSET', 'reservation:' .. rider, riderLine, sku)
    -- Added before this order's member is removed, so the set still exists and keeps the TTL
    -- reserve.lua gave it. If it has already expired the cap has reset, and a new set here would
    -- have no TTL at all, so leave it out.
    if redis.call('EXISTS', userKey .. sku) == 1 then
      redis.call('SADD', userKey .. sku, rider .. ':' .. riderLine)
    end
    passed = passed + 1
  else
    if redis.call('EXISTS', 'avail:' .. sku) == 1 then
      redis.call('INCRBY', 'avail:' .. sku, 1)
      released = released + 1
    else
      skipped = skipped + 1
    end
    local resv = tonumber(redis.call('DECRBY', 'reserved:' .. sku, 1))
    -- Nothing held for this SKU any more, so delete the key rather than leave a zero behind.
    if resv <= 0 then redis.call('DEL', 'reserved:' .. sku) end
  end
  if userKey then redis.call('SREM', userKey .. sku, orderId .. ':' .. lineno) end
end
redis.call('DEL', key)
return cjson.encode({released = released, skipped = skipped, passed = passed})
