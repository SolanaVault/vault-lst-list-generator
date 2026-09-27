-- The Vault - Liquid Unstaker Stats Liquidity and Unstakes
-- v23 - APPLIED 2026-08-22: APY annualized by the window's ACTUAL elapsed
-- time (was fixed ^52 / ^(365/30), the latter an integer-division 12).
-- Understated APY by ~0.18pp typically, up to 4pp. No epoch/slot assumptions.
-- v22 - APPLIED 2026-08-21: vlp_price = running max of the trailing-24h
-- MINIMUM of the rate (see rate_floor_24h) - 1-hour valuation transients can
-- no longer latch the monotonic price line; only 24h-sustained levels count.
-- v21 - APPLIED 2026-08-21: forward-filled LST rates now ACCRUE at each
-- mint's own measured daily drift (see lst_drift / lst_rate_filled). Held
-- inventory earns continuously between re-marks, removing the multi-day
-- vlp_price plateaus caused by flat marks during long holds. (A realizable-
-- value haircut was evaluated first and rejected: measured realized/marked
-- median = 1.0004, and plateau count was unchanged in backtest.)
-- v20 - APPLIED 2026-07-24: volume-weighted daily LST rates (see
-- lst_rate_per_day comment) - removes the entry mark-down that pinned
-- vlp_price flat during the bot's large LST inventory cycles.
-- v19 - APPLIED 2026-07-18: dust guard in lst_trade_rates (dust trades were
-- re-marking large LST inventory at garbage rates; see the CTE comment).
-- v18 - APPLIED 2026-07-10. Matview-based architecture, ~7 credits/run
-- (was ~126). Output verified identical to v14 across 26,467 rows.
--
-- READS (all dune.kagren0.*): result_vault_unstake_program_txs (x1),
-- result_vault_account_activity (x3), result_vault_stake_balance_changes (x2).
-- VLP supply branch stays INLINE (once-daily run beats a dedicated matview).
--
-- REFRESH CHAIN (UTC; Dune fires crons 15-80 min late with stable per-view
-- offsets - gaps below survive a 90-min offset + 10-min runtime worst case):
--   01:00 result_vault_unstake_program_txs          2.4-4 cr  (root)
--   03:00 Sun result_vault_stake_balance_changes_hist ~28 cr/wk
--   03:00 result_vault_account_activity             8-10 cr
--   03:30 result_vault_stake_balance_changes        2-3 cr
--   06:00 this query's matview                      ~7 cr
-- Plus a consistency guard in the final WHERE: output is capped at the
-- account-activity matview's max(block_time), so an out-of-order refresh can
-- only truncate the head, never emit mixed-freshness rows.
-- OPTIMIZED VERSION (v4 - materialized tx feed + full instruction coverage)
--
-- v4 changes:
--
--  (I)  CREDITS: the old `unstake_program_txs` CTE (scan of
--       solana.instruction_calls) was referenced by THREE consumers
--       (vault_account_activity, vault_transactions, unstake_instructions).
--       DuneSQL inlines CTEs at every reference, so the big scan ran 3x per
--       execution. It now lives in its own query ("The Vault - Unstake
--       Program Txs", see dune/vault_unstake_program_txs.sql) materialized as
--       dune.kagren0.result_vault_unstake_program_txs and read 3x cheaply
--       here. Refresh the matview at least hourly (this query only emits rows
--       older than 60 minutes, so hourly is sufficient).
--
--  (II) INSTRUCTION COVERAGE (verified against target/idl/liquid_unstaker.json):
--       unstake_instructions previously only matched liquid_unstake_lst
--       (0x54aefbf56c4021b9) and liquid_unstake_stake_account
--       (0x06f2f2003de6603a). Added as unstakes (user exits, LST/stake -> SOL):
--           0xcdc7a165ef6d94a3 liquid_unstake_lst_with_seed
--           0x586de05840f9f375 liquid_unstake_lst_with_wrapped
--           0x51977d69261cc768 liquid_unstake_lst_with_wrapped_seed
--           0x64034fd1bf9db40b sell_lst (v3 exit path)
--       buy_lst (0x3861528a72ba350c) is SOL -> LST (opposite direction), so it
--       is counted in a NEW separate column buys_per_day, not in
--       unstakes_per_day.
--
--  (III) Removed pda_accounts from unstake_instructions: dead code, nothing
--       downstream read it (only the row count is used).
--
-- ---------------------------------------------------------------------------
-- Prior optimization notes (v3) retained below:
--
--  (A) The unstaking program was upgraded to v3 and now buys/sells LSTs
--      (jupSOL, jitoSOL, bSOL, vSOL, ...). The pool therefore holds LST
--      inventory whose SOL value must be added to TVL and the VLP exchange
--      rate. A Solana program upgrade keeps the same program id, so the
--      existing 2rU1oCHtQ7... filter already captures all v3 activity.
--
--  (B) LST inventory is custodied by the vault authority PDA
--      9nyw5jxhzuSs88HxKJyDCsWBZMhxj2uNXsFcyHF5KBAb (the same PDA that owns
--      the native stake accounts). The LSTs are NOT under the SOL reserve.
--      The set of vault accounts (reserve + fee + all owned LST token accounts)
--      is read from a small table, dune.kagren0.result_vault_lst_account_detector,
--      refreshed out-of-band by an owner-scan of solana_utils.token_accounts for
--      9nyw5jx... So any LST the bot rotates into is tracked automatically - no
--      hard-coded mint list to maintain.
--
--  (C) CREDIT NOTE: `vault_addresses` is a tiny table (~a dozen rows), so the
--      account_activity scan still bucket-prunes by `address` via dynamic
--      filtering - exactly as cheap as the old literal IN-list (measured ~85
--      credits). Reserve SOL, the fee account and LST balances share ONE
--      account_activity scan (`vault_account_activity`). IMPORTANT: do NOT
--      inline the solana_utils.token_accounts owner-scan here - that build side
--      is huge and gets re-run per consumer, which was measured at ~3x cost.
--      Keep the owner-scan in the detector query and read its small result here.
--
--  (D) LST valuation = "implied from the pool's own trades" (intrinsic, exact).
--      For each tx where exactly ONE vault LST moved and the reserve SOL moved
--      the opposite way, the implied rate uses the buy/sell balance differences
--      with the protocol fee (paid to F3yy3FVpwq9MV321AzALFcDWZp9XBBHbMas3t4AtEtCW)
--      separated out:
--          rate_sol = -((reserve_sol_change + fee_sol_change) / 1e9) / lst_change.
--      (fee_sol_change is always >= 0; adding it back removes the fee/spread so
--      the rate reflects the LST's true SOL value, not the post-fee price.)
--      Rates are taken per (mint, day) and forward filled (daily granularity).
--      LST *balances* are tracked at per-block granularity (running sum of
--      token-balance changes, sampled at every output block) so intraday
--      SOL<->LST conversions stay consistent with the per-block reserve/stake
--      balances. lst_value = sum_mint(balance * rate) * 1e9 (lamports), folded
--      into total_balance so exchange_rate / APY include it. Caveat: a rate only
--      refreshes when the pool does a clean single-LST swap vs the reserve; an
--      LST held without trading keeps its last observed rate.
--
-- Prior optimization notes (v2) retained below:
--  (1) Inlined helper query 5635004 as `stake_balance_changes`.
--  (2) Partition floor 2024-10-19 (vault inception) on all Solana scans.
--  (3) Removed dead CTEs pda_transactions_of_interest + pda_balances.
--  (4) EXISTS -> INNER JOIN against pre-filtered unstake-program tx coords.
--  (5) Tighter floors: unstake_instructions 2025-04-01; cumulative_unstaked
--      2025-03-01; query_5337921 ref 2025-04-01.

with
reserve_tx_sol as (
    -- Reserve native-SOL change per tx (replaces the old reserve scan; now
    -- sourced from the shared scan). Reused for TVL and implied LST rates.
    select
        block_time,
        block_slot,
        tx_index,
        sum(balance_change) reserve_sol_change
    from dune.kagren0.result_vault_account_activity
    where address = '6RLKARrt6oPCyuMCdYdUHmJxd4wUa6ZeyiC8VSMcYxRv'
    group by 1,2,3
),

fee_tx_sol as (
    -- Protocol fee (native SOL) collected per tx, paid to F3yy3... Used to
    -- separate the fee from the LST exchange rate so the rate is fee-exclusive.
    select
        block_time,
        block_slot,
        tx_index,
        sum(balance_change) fee_sol_change
    from dune.kagren0.result_vault_account_activity
    where address = 'F3yy3FVpwq9MV321AzALFcDWZp9XBBHbMas3t4AtEtCW'
    group by 1,2,3
),

balance_changes as (
    select
        aa.block_time,
        aa.block_slot,
        aa.index tx_index,
        sum(aa.balance_change_without_reward) stake_account_change,
        cast(null as double) reserve_balance_change
    from dune.kagren0.result_vault_stake_balance_changes aa
    group by 1,2,3

    union all

    -- Reserve native SOL (read from the shared scan, not re-scanned).
    select
        block_time,
        block_slot,
        tx_index,
        cast(null as double),
        cast(reserve_sol_change as double)
    from reserve_tx_sol
),

-- ----- LST inventory valuation (implied-from-trades) ------------------------

lst_tx_changes as (
    -- Per (tx, mint): net LST token-balance change.
    select
        block_time,
        block_slot,
        tx_index,
        mint,
        cast(sum(token_balance_change) as double) lst_change
    from dune.kagren0.result_vault_account_activity
    where mint is not null
      and token_balance_change is not null
    group by 1,2,3,4
),

lst_trade_rates as (
    -- Implied SOL/LST from txs where exactly ONE vault LST moved and the
    -- reserve SOL moved the opposite way. The protocol fee (sent to F3yy3...)
    -- is added back to the reserve leg so the rate is fee-exclusive (the LST's
    -- true SOL value, not the post-fee execution price):
    --     rate = -((reserve_sol_change + fee_sol_change) / 1e9) / lst_change.
    select
        c.block_time,
        c.block_slot,
        c.mint,
        abs(c.lst_change) trade_size,
        -((cast(r.reserve_sol_change as double) + coalesce(f.fee_sol_change, 0))
            / 1e9) / c.lst_change rate_sol
    from (
        select
            *,
            count(*) over (partition by block_time, block_slot, tx_index) n_mints
        from lst_tx_changes
    ) c
    inner join reserve_tx_sol r
      on  r.block_time = c.block_time
      and r.block_slot = c.block_slot
      and r.tx_index   = c.tx_index
    left join fee_tx_sol f
      on  f.block_time = c.block_time
      and f.block_slot = c.block_slot
      and f.tx_index   = c.tx_index
    where c.n_mints = 1
      -- v19 DUST GUARD (2026-07-18): dust-sized transfers (~1e-6 tokens) were
      -- setting the (mint, day) implied rate to lamport-quantized garbage
      -- (1.00, 1.11, 1.25, ...) because max_by picks the LAST trade of the
      -- day. On Jul 13 a dust trade marked the pool's 104.19 jupSOL at 1.00
      -- vs ~1.19 true => -20 SOL paper dip and a flat vlp_price for days.
      -- Rates may only be set by trades of >= 0.01 LST against >= 0.01 SOL.
      and abs(c.lst_change) >= 0.01
      and abs(cast(r.reserve_sol_change as double)) >= 1e7
      and sign(cast(r.reserve_sol_change as double)) = -sign(c.lst_change)
),

lst_rate_per_day as (
    -- v20 (2026-07-24): VOLUME-WEIGHTED daily rate instead of last-print
    -- (max_by(rate_sol, block_slot)). The bot now cycles ~4,000 SOL (>90% of
    -- TVL) through LST inventory every 1-3 days. Marking the whole book at the
    -- day's LAST print - which can sit a few bps under the blended execution
    -- price - created an instant paper mark-down at every entry, pinning the
    -- monotonic vlp_price flat for days (observed Jul 16-20 and Jul 21-22).
    -- VWAP values the book at the blended fee-exclusive price actually traded.
    select mint, date(block_time) block_date,
           sum(rate_sol * trade_size) / sum(trade_size) rate_sol
    from lst_trade_rates
    group by 1,2
),

lst_mints as (
    select distinct mint from lst_tx_changes
),

lst_date_spine as (
    select day
    from unnest(
        sequence(
            coalesce((select date(min(block_time)) from lst_tx_changes), current_date),
            current_date,
            interval '1' day
        )
    ) as t(day)
),

lst_drift as (
    -- v21 (2026-08-21): per-mint daily accrual rate, estimated from the
    -- mint's OWN implied-rate history (least-squares slope of ln(rate) vs
    -- day), clamped to [0, 0.05%]/day. Used below to accrete held inventory
    -- between re-marks. The estimate re-anchors at every real trade, so any
    -- error is bounded by (drift error x days since last trade) - a few bps
    -- at most for holds of a few days.
    select mint,
           greatest(0, least(0.0005,
               (count(*) * sum(x * y) - sum(x) * sum(y))
               / nullif(count(*) * sum(x * x) - sum(x) * sum(x), 0)
           )) drift
    from (
        select mint,
               cast(date_diff('day', date '2024-10-19', block_date) as double) x,
               ln(rate_sol) y
        from lst_rate_per_day
        where rate_sol > 0
    )
    group by mint
    having count(*) >= 2
),

lst_rate_filled as (
    -- v21: forward-fill the daily implied rate per mint, ACCRUING at the
    -- mint's estimated drift between observations. Before v21 the rate was
    -- carried flat between trades, so a large held book showed zero earnings
    -- until the next re-mark - producing multi-day vlp_price plateaus ended
    -- by artificial step-jumps (e.g. +4.4 SOL at the Aug 17 epoch re-mark).
    -- With accrual, value grows smoothly during holds and re-marks become
    -- small corrections instead of cliffs.
    select
        f.mint,
        f.day,
        f.base_rate * exp(coalesce(d.drift, 0)
            * date_diff('day', f.base_day, f.day)) rate_sol
    from (
        select
            g.mint,
            g.day,
            last_value(r.rate_sol) ignore nulls over (
                partition by g.mint order by g.day
                rows between unbounded preceding and current row
            ) base_rate,
            last_value(case when r.rate_sol is not null then g.day end)
                ignore nulls over (
                partition by g.mint order by g.day
                rows between unbounded preceding and current row
            ) base_day
        from (select m.mint, d.day from lst_mints m cross join lst_date_spine d) g
        left join lst_rate_per_day r on r.mint = g.mint and r.block_date = g.day
    ) f
    left join lst_drift d on d.mint = f.mint
),

cumulative_unstaked as (
    select
        block_date,
        avg(stake_balance_rolling_30_days) stake_balance_rolling_30_days
    from (
        select
            date(block_time) block_date,
            sum(balance_change_without_reward) over (
                order by block_time
                range between interval '30' day preceding and current row
            ) stake_balance_rolling_30_days
        from dune.kagren0.result_vault_stake_balance_changes
        where balance_change_without_reward > 0
          and block_time >= date '2025-03-01'
    )
    group by 1
),

balances_accumulated as (
    select
        block_time,
        block_slot,
        tx_index,
        sum(reserve_balance_change) over (order by block_time, block_slot, tx_index) vault_balance,
        sum(stake_account_change)  over (order by block_time, block_slot, tx_index) stake_balance
    from balance_changes
),

base as (
    select
        a.block_time,
        a.block_slot,
        max_by(vault_balance, tx_index) vault_balance,
        max_by(stake_balance, tx_index) stake_balance
    from balances_accumulated a
    group by 1,2
),

lst_running as (
    -- Per-block running LST balance per mint, sampled at every output block.
    -- We union the actual LST balance-change events with one zero-change
    -- "anchor" per (output block, mint); a running sum then carries each
    -- mint's balance forward to every output block. Anchors use a large
    -- tx_index so they sort AFTER any real tx in the same block (= end-of-block
    -- balance). Restricted to blocks at/after the first LST trade.
    select
        block_time,
        block_slot,
        mint,
        is_base,
        sum(lst_change) over (
            partition by mint
            order by block_time, block_slot, tx_index
            rows between unbounded preceding and current row
        ) bal
    from (
        select block_time, block_slot, tx_index, mint, lst_change, 0 is_base
        from lst_tx_changes
        union all
        select b.block_time, b.block_slot, cast(2000000000 as integer) tx_index,
               m.mint, cast(0 as double) lst_change, 1 is_base
        from base b
        cross join lst_mints m
        where b.block_time >= (select min(block_time) from lst_tx_changes)
    )
),

lst_value_per_block as (
    -- Sum over mints of (per-block balance * forward-filled daily rate).
    -- Result in lamports to match vault/stake balances.
    select
        r.block_time,
        r.block_slot,
        sum(r.bal * coalesce(rf.rate_sol, 0)) * 1e9 lst_value
    from lst_running r
    left join lst_rate_filled rf
      on rf.mint = r.mint and rf.day = date(r.block_time)
    where r.is_base = 1
    group by 1,2
),

-- ---------------------------------------------------------------------------

unstake_instructions as (
    -- All user-facing pool trades, classified by Anchor discriminator
    -- (verified against target/idl/liquid_unstaker.json).
    -- 'unstake' = user exit (LST or stake account -> SOL).
    -- 'buy'     = buy_lst (SOL -> LST), counted separately so it does not
    --             inflate the unstake metric.
    select
        block_time,
        block_slot,
        case
            when bytearray_substring(data, 1, 8) = 0x3861528a72ba350c
            then 'buy'
            else 'unstake'
        end event_type
    from dune.kagren0.result_vault_unstake_program_txs
    where block_date >= date '2025-04-01'
      and bytearray_substring(data, 1, 8) in (
            0x54aefbf56c4021b9, /* liquid_unstake_lst */
            0xcdc7a165ef6d94a3, /* liquid_unstake_lst_with_seed */
            0x586de05840f9f375, /* liquid_unstake_lst_with_wrapped */
            0x51977d69261cc768, /* liquid_unstake_lst_with_wrapped_seed */
            0x06f2f2003de6603a, /* liquid_unstake_stake_account */
            0x64034fd1bf9db40b, /* sell_lst (v3 LST -> SOL exit) */
            0x3861528a72ba350c  /* buy_lst  (v3 SOL -> LST, separate count) */
      )
),

unstakes_per_day as (
    select
        date(block_time) block_date,
        count_if(event_type = 'unstake') unstakes,
        count_if(event_type = 'buy') buys
    from unstake_instructions
    group by 1
),

final as (
    select
        b.block_time,
        b.block_slot,
        b.vault_balance,
        u.unstakes unstakes_per_day,
        u.buys buys_per_day,
        b.stake_balance,
        coalesce(lv.lst_value, 0) lst_balance,
        coalesce(b.vault_balance, 0)
            + coalesce(b.stake_balance, 0)
            + coalesce(lv.lst_value, 0) total_balance
    from base b
    left join unstakes_per_day u on date(b.block_time) = u.block_date
    left join lst_value_per_block lv
      on lv.block_time = b.block_time and lv.block_slot = b.block_slot
)
select
    *,
    -- APY is now computed off vlp_price (the monotonic running-max series), not
    -- the raw exchange_rate. The raw rate carries endpoint noise of the same
    -- order as the 7-day yield signal, and annualizing (^52) amplifies it into
    -- large swings between reruns. vlp_price is non-decreasing, so these APYs are
    -- stable across reruns and never negative from measurement noise.
    -- v23 (2026-08-22) ANNUALIZATION: the exponent is now derived from the
    -- window's ACTUAL elapsed wall-clock time, not a fixed 52 / (365/30).
    -- Rows are event-driven (one per vault tx), so `range interval '7' day`
    -- starts at the first row at-or-after t-7d - typically 6.94d, p05 6.42d,
    -- occasionally far less. The old fixed exponents therefore understated
    -- APY (7d: mean -0.18pp, worst -3.98pp; e.g. 2026-08-21 read 5.35% vs
    -- 5.66% true). The 30d exponent was also written `365 / 30`, which is
    -- INTEGER division in Trino => 12 instead of 12.1667, a further ~-0.09pp.
    -- Both windows remain wall-clock (block_time), so they are unaffected by
    -- Solana slot-time changes (e.g. 400ms -> 350ms) or epoch-length drift;
    -- no epoch-length assumption exists anywhere in this query.
    -- Windows shorter than half the nominal period annualize noise, so they
    -- return NULL rather than a wild number (affects only series start).
    case when w7_span_s >= 302400 then
        100 * (pow(vlp_price / nullif(w7_first_px, 0),
                   31536000.0 / w7_span_s) - 1)
    end vlp_7_days_apy,
    case when w30_span_s >= 1296000 then
        100 * (pow(vlp_price / nullif(w30_first_px, 0),
                   31536000.0 / w30_span_s) - 1)
    end vlp_30_days_apy
from (
    select
        *,
        first_value(vlp_price) over (
            order by block_time
            range between interval '7' day preceding and current row
        ) w7_first_px,
        date_diff('second',
            first_value(block_time) over (
                order by block_time
                range between interval '7' day preceding and current row
            ), block_time) w7_span_s,
        first_value(vlp_price) over (
            order by block_time
            range between interval '30' day preceding and current row
        ) w30_first_px,
        date_diff('second',
            first_value(block_time) over (
                order by block_time
                range between interval '30' day preceding and current row
            ), block_time) w30_span_s
    from (
    select
        *,
        -- Monotonic VLP price = running max of the 24h-sustained floor.
        max(rate_floor_24h) over (
            order by block_time, block_slot
            rows between unbounded preceding and current row
        ) vlp_price
    from (
    select
        *,
        stake_balance / 1e9 stake_balance_sol,
        vault_balance / 1e9 vault_balance_sol,
        lst_balance   / 1e9 lst_balance_sol,
        total_balance / 1e9 total_balance_sol,
        -- v22 SPIKE-PROOF FLOOR (2026-08-21): trailing-24h minimum of the
        -- rate. vlp_price (next layer) is the running max of THIS, so a level
        -- must be SUSTAINED for 24h before it can set the price. Previously
        -- vlp_price latched 1-hour valuation transients: on Aug 17 a fresh
        -- post-epoch re-mark printed 3 rows (01:45-02:45) that the exit
        -- realized 2.9 SOL below, pre-consuming 4 days of real growth and
        -- flat-lining the chart while the pool earned +3.9 SOL. Backtest:
        -- plateaus >24h since Jul 1 drop 9 -> 5. Cost: genuine step-ups are
        -- recognized with up to 24h lag.
        min(exchange_rate) over (
            order by block_time
            range between interval '24' hour preceding and current row
        ) rate_floor_24h
    from (
    select
        a.*,
        exchange_rate - lag(exchange_rate, 1) over (order by block_time, block_slot) exchange_rate_delta_vs_prev,
        date(a.block_time) block_date,
        cu.stake_balance_rolling_30_days / 1e9 stake_balance_rolling_30_days
    from (
        select
            b.*,
            s.supply vlp_supply,
            last_value(s.supply) ignore nulls over (order by b.block_time, b.block_slot) vlp_supply_most_recent,
            cast(b.total_balance as double)
                / last_value(s.supply) ignore nulls over (order by b.block_time, b.block_slot) exchange_rate
        from final b
        left join (
            with mints_and_burns as (
                select
                    call_block_time, call_block_slot, call_tx_index,
                    call_outer_instruction_index, call_inner_instruction_index,
                    amount
                from spl_token_solana.spl_token_call_mintto
                where account_mint = 'EUWoTx5vQQrxaDFdeK2PLUVbnmRWjw4x6sBbmcxBaHjF'
                  and call_block_date >= date '2024-10-19'
                union all
                select
                    call_block_time, call_block_slot, call_tx_index,
                    call_outer_instruction_index, call_inner_instruction_index,
                    amount
                from spl_token_solana.spl_token_call_minttoChecked
                where account_mint = 'EUWoTx5vQQrxaDFdeK2PLUVbnmRWjw4x6sBbmcxBaHjF'
                  and call_block_date >= date '2024-10-19'
                union all
                select
                    call_block_time, call_block_slot, call_tx_index,
                    call_outer_instruction_index, call_inner_instruction_index,
                    -amount
                from spl_token_solana.spl_token_call_burn
                where account_mint = 'EUWoTx5vQQrxaDFdeK2PLUVbnmRWjw4x6sBbmcxBaHjF'
                  and call_block_date >= date '2024-10-19'
                union all
                select
                    call_block_time, call_block_slot, call_tx_index,
                    call_outer_instruction_index, call_inner_instruction_index,
                    -amount
                from spl_token_solana.spl_token_call_burnChecked
                where account_mint = 'EUWoTx5vQQrxaDFdeK2PLUVbnmRWjw4x6sBbmcxBaHjF'
                  and call_block_date >= date '2024-10-19'
            ),
            vlp_supply as (
                select
                    *,
                    sum(amount) over (
                        order by call_block_time, call_block_slot, call_tx_index,
                                 call_outer_instruction_index, call_inner_instruction_index
                    ) supply
                from mints_and_burns
            )
            select
                call_block_time,
                call_block_slot,
                max_by(
                    supply,
                    call_tx_index * 10000
                        + call_outer_instruction_index * 100
                        + call_inner_instruction_index
                ) supply
            from vlp_supply
            group by 1,2
        ) s
          on b.block_time = s.call_block_time
         and b.block_slot = s.call_block_slot
    ) a
    left join cumulative_unstaked cu on date(a.block_time) = cu.block_date
    where
        a.block_time > date '2025-04-01'
        and a.block_time < current_timestamp - interval '60' minute
        -- CONSISTENCY GUARD: never emit rows newer than the account-activity
        -- matview's coverage. Every vault tx moves reserve or fee SOL, so its
        -- max(block_time) equals the newest vault tx it knows about. If a
        -- refresh ever runs out of order (Dune fires crons 15-80 min late with
        -- per-view offsets), the head of the series is truncated instead of
        -- being computed from mixed-freshness inputs (missing reserve legs).
        and a.block_time <= (select max(block_time)
                             from dune.kagren0.result_vault_account_activity)
    )
    where exchange_rate_delta_vs_prev > 0
    )
)
)
order by block_time desc

-- ===========================================================================
-- HELPER (not part of the query) - refresh the LST token-account list in
-- `vault_addresses` above. Run this standalone whenever the vault may have
-- started holding a new LST, then paste the (address, mint) rows in.
--
--   select address, token_mint_address
--   from solana_utils.token_accounts
--   where token_balance_owner = '9nyw5jxhzuSs88HxKJyDCsWBZMhxj2uNXsFcyHF5KBAb'
--   order by token_mint_address;
--
-- AUTO-DETECT ALTERNATIVE (no manual maintenance, but ~3x query credits because
-- the owner filter forces a full snapshot scan of solana_utils.token_accounts):
-- replace the VALUES block in `vault_addresses` with --
--
--   select '6RLKARrt6oPCyuMCdYdUHmJxd4wUa6ZeyiC8VSMcYxRv', cast(null as varchar)
--   union all
--   select 'F3yy3FVpwq9MV321AzALFcDWZp9XBBHbMas3t4AtEtCW', cast(null as varchar)
--   union all
--   select address, token_mint_address
--   from solana_utils.token_accounts
--   where token_balance_owner = '9nyw5jxhzuSs88HxKJyDCsWBZMhxj2uNXsFcyHF5KBAb'
--
-- and remove the literal `aa.address in (...)` filter in vault_account_activity
-- (replace the LEFT JOIN with INNER JOIN vault_addresses so it both filters and
-- maps the mint). Expect higher credit usage if you do this.
-- ===========================================================================
