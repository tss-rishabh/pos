-- RE-DECREMENT — the order was paid. Every line ends up holding a unit, or comes back as one we cannot fulfil.
--
-- ARGV[1] = orderId
-- ARGV[2] = [{"lineno":"41083836","sku":"195005"}, ...]
-- ARGV[3] = userId, empty string if unknown
-- ARGV[4] = [{"order":"123","lineno":"41083801","sku":"195005"}, ...] the same customer's other
--           unpaid (order_status = 0) lines for these skus - the orders a unit can be taken back from
--
-- Checked per line, because a line can be held, riding, or neither:
--   held    - nothing to do
--   riding  - a paid order beats an unpaid one, so take the unit back from the customer's own
--             unpaid order and make that order the rider. No counter moves.
--   neither - take a fresh unit off avail if it has one; if not, a riding line is reported
--             unfulfillable so Go can cancel it, any other line is held anyway and alerted on
local orderId = ARGV[1]
local lines = cjson.decode(ARGV[2])
local userId = (ARGV[3] ~= nil and ARGV[3] ~= '') and ARGV[3] or nil
local candidates = (ARGV[4] ~= nil and ARGV[4] ~= '') and cjson.decode(ARGV[4]) or {}
local key = 'reservation:' .. orderId
local ridersKey = userId and ('riders:' .. userId .. ':') or nil

-- Mark the order paid before anything else is read or written.
redis.call('SETEX', 'paid:' .. orderId, 86400, 1)

-- A candidate is only real if it still holds that sku on that line; the DB row says nothing about Redis.
local function takeOwner(sku)
  for _, c in ipairs(candidates) do
    if c.sku == sku and c.order ~= orderId
        and redis.call('EXISTS', 'paid:' .. c.order) == 0
        and redis.call('HGET', 'reservation:' .. c.order, c.lineno) == sku then
      c.sku = nil  -- never take from the same line twice when this order has two lines of one sku
      return c.order, c.lineno
    end
  end
  return nil
end

local held = 0
local claimed = {}
local toHold = {}
for _, l in ipairs(lines) do
  if redis.call('HGET', key, l.lineno) == l.sku then
    held = held + 1
  else
    local riding = redis.call('HGET', 'rider:' .. orderId, l.lineno) == l.sku
    if riding then
      redis.call('HDEL', 'rider:' .. orderId, l.lineno)
      if ridersKey then redis.call('SREM', ridersKey .. l.sku, orderId .. ':' .. l.lineno) end
    end
    local owner, ownerLine
    if riding then owner, ownerLine = takeOwner(l.sku) end
    if owner then
      redis.call('HDEL', 'reservation:' .. owner, ownerLine)
      redis.call('HSET', 'rider:' .. owner, ownerLine, l.sku)
      if userId then
        redis.call('SADD', ridersKey .. l.sku, owner .. ':' .. ownerLine)
        -- The owner no longer holds a unit, so it stops counting against the cap.
        redis.call('SREM', 'userhold:' .. userId .. ':' .. l.sku, owner .. ':' .. ownerLine)
      end
      redis.call('HSET', key, l.lineno, l.sku)
      claimed[#claimed + 1] = l.sku
    else
      toHold[#toHold + 1] = {lineno = l.lineno, sku = l.sku, riding = riding}
    end
  end
end

if #toHold == 0 then
  if #claimed == 0 then return cjson.encode({redecremented = false, reason = 'still_held'}) end
  return cjson.encode({redecremented = false, claimed = claimed})
end

-- The per-user hold set is deliberately left alone here. That cap exists to stop one account
-- tying up a sku with orders it has not paid for; this order HAS been paid for, so it should not
-- count against the customer. RETIRE's SREM later is a no-op for it, which is fine.
--
-- When avail is out, only a line whose sibling took the unit is cancelled; the rest are held, since
-- a 0 that is merely stale or unseeded is not proof the item cannot ship.
local remaining = {}
local decremented = {}
local no_counter = {}
local unfulfillable = {}
local floored = {}
for _, l in ipairs(toHold) do
  if remaining[l.sku] == nil then
    local avail = redis.call('GET', 'avail:' .. l.sku)
    remaining[l.sku] = avail and tonumber(avail) or false
  end
  local left = remaining[l.sku]
  if left == false then
    -- No counter, so nothing to check against. Held as before; DECRBY would create the key at -1.
    redis.call('INCRBY', 'reserved:' .. l.sku, 1)
    redis.call('HSET', key, l.lineno, l.sku)
    no_counter[#no_counter + 1] = l.sku
  elseif left > 0 then
    redis.call('DECRBY', 'avail:' .. l.sku, 1)
    redis.call('INCRBY', 'reserved:' .. l.sku, 1)
    redis.call('HSET', key, l.lineno, l.sku)
    remaining[l.sku] = left - 1
    decremented[#decremented + 1] = l.sku
  elseif l.riding then
    unfulfillable[#unfulfillable + 1] = {lineno = l.lineno, sku = l.sku}
  else
    -- No sibling to blame, so the counter is the suspect, not the stock.
    redis.call('INCRBY', 'reserved:' .. l.sku, 1)
    redis.call('HSET', key, l.lineno, l.sku)
    floored[#floored + 1] = l.sku
  end
end
return cjson.encode({redecremented = #decremented > 0, claimed = claimed, decremented = decremented, no_counter = no_counter, unfulfillable = unfulfillable, floored = floored})
