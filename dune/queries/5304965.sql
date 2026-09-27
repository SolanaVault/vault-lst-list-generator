-- VLP plot feed for the Liquid Unstaker dashboard.
--
-- vlp_price        : running max of exchange_rate => monotonic VLP price line.
-- tvl_sol_reserve  : SOL held in the reserve.
-- tvl_staked       : SOL in the vault's native stake accounts.
-- tvl_lst          : SOL value of LST inventory. Derived as total - reserve -
--                    stake so this query NEVER breaks on the column set: it is
--                    0 on the old (pre-LST) materialized result and becomes the
--                    real LST value automatically once query 6837679 (v3) is
--                    re-run from the Dune UI / scheduled refresh.
-- The three tvl_* columns stack to total_balance_sol (= TVL).
select
    *,
    vault_balance_sol as tvl_sol_reserve,
    stake_balance_sol as tvl_staked,
    total_balance_sol - vault_balance_sol - stake_balance_sol as tvl_lst
    -- v22 (2026-08-21): vlp_price now comes straight from the matview column
    -- (running max of the 24h-sustained rate floor) - do NOT recompute a raw
    -- running max here, it would re-introduce spike-latched plateaus.
from dune.kagren0.result_the_vault_liquid_unstaker_stats_liquidity_and_unstakes
where block_time >= current_timestamp - interval '90' day
order by block_time desc, block_slot desc