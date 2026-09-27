-- The Vault Stake Pool TVL — multi-LST, denominated in SOL
--
-- Architecture (daily-cheap):
--   • Historical daily LST supply is read from `dune.kagren0.result_lst_daily_supply`
--     (query 7599149, refresh weekly).
--   • Days newer than the cache get computed live from `tokens_solana.transfers`
--     (a cheap 14-day window scan).
--   • Daily SOL/LST price is the weekly volume-weighted ratio from
--     `dune.kagren0.result_v_sol_price_in_sol` (query 6707718, refresh weekly).
--
-- Typical daily run cost: ~3-5 credits (vs ~27 for the all-inline version).

with stake_pools(symbol, mint) as (
    values
        ('vSOL',    'vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7'),
        ('dzSOL',   'Gekfj7SL2fVpTDxJZmeC46cTYxinjB6gkAnb6EGT6mnn'),
        ('jupSOL',  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v'),
        ('mSOL',    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'),
        ('jitoSOL', 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn')
),

----------------------------------------------------------------
-- Cached historical supply (up to ~last weekly refresh)
----------------------------------------------------------------
historical as (
    select block_date, mint, lst_supply
    from dune.kagren0.result_lst_daily_supply
    where block_date > current_date - interval '12' month
),

-- Most recent cached supply per mint — the anchor for the live extension
last_cached as (
    select mint, max(block_date) as max_date
    from historical
    group by mint
),
anchor as (
    select h.mint, h.block_date as anchor_date, h.lst_supply as anchor_supply
    from historical h
    join last_cached lc on lc.mint = h.mint and lc.max_date = h.block_date
),

----------------------------------------------------------------
-- Live deltas for the last 14 days (cheap, ~1 credit)
----------------------------------------------------------------
recent_deltas as (
    select t.block_date, t.token_mint_address as mint,
           sum(case when t.action = 'mint' then t.amount_display else 0 end) -
           sum(case when t.action = 'burn' then t.amount_display else 0 end) as net_delta
    from tokens_solana.transfers t
    where t.block_date >= current_date - interval '14' day
      and t.action in ('mint', 'burn')
      and t.token_mint_address in (select mint from stake_pools)
    group by 1, 2
),

-- Extend the cached series with cumulative deltas after the anchor day
extended as (
    select rd.block_date, rd.mint,
           a.anchor_supply +
           sum(rd.net_delta) over (
               partition by rd.mint order by rd.block_date
               rows between unbounded preceding and current row
           ) as lst_supply
    from recent_deltas rd
    join anchor a on a.mint = rd.mint
    where rd.block_date > a.anchor_date
),

----------------------------------------------------------------
-- Combine historical + extended, label pools, and price in SOL
----------------------------------------------------------------
all_supply as (
    select * from historical
    union all
    select * from extended
)

select
    s.block_date,
    sp.symbol as stake_pool,
    s.mint,
    s.lst_supply,
    coalesce(
        r.price,
        last_value(r.price) ignore nulls
            over (partition by s.mint order by s.block_date
                  rows between unbounded preceding and current row)
    ) as sol_per_lst,
    s.lst_supply * coalesce(
        r.price,
        last_value(r.price) ignore nulls
            over (partition by s.mint order by s.block_date
                  rows between unbounded preceding and current row)
    ) as tvl_sol
from all_supply s
join stake_pools sp on sp.mint = s.mint
left join dune.kagren0.result_v_sol_price_in_sol r
    on r.week_start = date_trunc('week', s.block_date)
   and r.mint       = s.mint
order by s.block_date, sp.symbol
