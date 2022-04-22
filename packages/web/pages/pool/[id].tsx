import { CoinPretty, Dec, PricePretty, RatePretty } from "@keplr-wallet/unit";
import { Staking } from "@keplr-wallet/stores";
import {
  ObservableQueryGuageById,
  ObservableAddLiquidityConfig,
  ObservableRemoveLiquidityConfig,
  ObservableAmountConfig,
} from "@osmosis-labs/stores";
import { Duration } from "dayjs/plugin/duration";
import moment from "dayjs";
import { autorun } from "mobx";
import { observer } from "mobx-react-lite";
import Image from "next/image";
import { useRouter } from "next/router";
import { FunctionComponent, useEffect, useState, useMemo } from "react";
import { Button } from "../../components/buttons";
import {
  PoolCatalystCard,
  PoolGaugeBonusCard,
  PoolGaugeCard,
} from "../../components/cards";
import { MetricLoader } from "../../components/loaders";
import { Overview } from "../../components/overview";
import { BaseCell, Table } from "../../components/table";
import { truncateString } from "../../components/utils";
import { ExternalIncentiveGaugeAllowList, EmbedChainInfos } from "../../config";
import {
  LockTokensModal,
  ManageLiquidityModal,
  SuperfluidValidatorModal,
} from "../../modals";
import { useStore } from "../../stores";

const Pool: FunctionComponent = observer(() => {
  const router = useRouter();
  const { chainStore, queriesStore, accountStore, priceStore } = useStore();

  const { id: poolId } = router.query;
  const { chainId } = chainStore.osmosis;

  const queryCosmos = queriesStore.get(chainId).cosmos;
  const queryOsmosis = queriesStore.get(chainId).osmosis;
  const account = accountStore.getAccount(chainStore.osmosis.chainId);
  const pool = queryOsmosis.queryGammPools.getPool(poolId as string);
  const { bech32Address } = accountStore.getAccount(chainId);
  const fiat = priceStore.getFiatCurrency(priceStore.defaultVsCurrency)!;

  // pool is loading if undefined
  let totalValueLocked: PricePretty | undefined;
  let userLockedValue: PricePretty | undefined;
  let userBondedValue: PricePretty | undefined;
  let userAvailableValue: PricePretty | undefined;
  let userPoolAssets: { ratio: RatePretty; asset: CoinPretty }[] | undefined;
  let userLockedAssets:
    | {
        duration: Duration;
        amount: CoinPretty;
        lockIds: string[];
        apr?: RatePretty;
      }[]
    | undefined;
  let userUnlockingAssets:
    | {
        duration: Duration;
        amount: CoinPretty;
        endTime: Date;
      }[]
    | undefined;
  let externalGuages:
    | {
        duration: string;
        rewardAmount?: CoinPretty;
        remainingEpochs: number;
      }[]
    | undefined;
  let guages: ObservableQueryGuageById[] | undefined;
  let superfluid:
    | "not-superfluid-pool" // code smell that we don't do loading right, consider other structure besides `undefined` for representing loading data
    | {
        // has superfluid-able shares locked, but has not chosen sfs validator
        upgradeableLPLockIds: {
          amount: CoinPretty;
          lockIds: string[];
        };
      }
    | {
        // has delegations or is undelegating
        delegations?: {
          validatorName?: string;
          validatorCommission?: RatePretty;
          validatorImgSrc: string;
          apr: RatePretty;
          amount: CoinPretty;
        }[];
        undelegations?: {
          validatorName?: string;
          amount: CoinPretty;
          endTime: Date;
        }[];
        superfluidLPShares: {
          amount: CoinPretty;
          lockIds: string[];
        };
      }
    | undefined;

  if (pool) {
    totalValueLocked = pool.computeTotalValueLocked(priceStore);
    userLockedValue = totalValueLocked?.mul(
      queryOsmosis.queryGammPoolShare.getAllGammShareRatio(
        bech32Address,
        pool.id
      )
    );
    userBondedValue = totalValueLocked
      ? queryOsmosis.queryGammPoolShare.getLockedGammShareValue(
          bech32Address,
          pool.id,
          totalValueLocked,
          fiat
        )
      : undefined;
    userAvailableValue = !pool.totalShare.toDec().equals(new Dec(0))
      ? totalValueLocked.mul(
          queryOsmosis.queryGammPoolShare
            .getAvailableGammShare(bech32Address, pool.id)
            .quo(pool.totalShare)
        )
      : new PricePretty(fiat, new Dec(0));
    userPoolAssets = pool.poolAssets.map((asset) => ({
      ratio: new RatePretty(asset.weight.quo(pool.totalWeight)),
      asset: asset.amount
        .mul(
          queryOsmosis.queryGammPoolShare.getAllGammShareRatio(
            bech32Address,
            pool.id
          )
        )
        .trim(true)
        .shrink(true),
    }));
    userLockedAssets = queryOsmosis.queryGammPoolShare
      .getShareLockedAssets(
        bech32Address,
        pool.id,
        queryOsmosis.queryLockableDurations.lockableDurations
      )
      .map((lockedAsset) =>
        // calculate APR% for this pool asset
        ({
          ...lockedAsset,
          apr: queryOsmosis.queryIncentivizedPools.isIncentivized(pool.id)
            ? new RatePretty(
                queryOsmosis.queryIncentivizedPools.computeAPY(
                  pool.id,
                  lockedAsset.duration,
                  priceStore,
                  fiat
                )
              )
            : undefined,
        })
      );
    const poolShareCurrency = queryOsmosis.queryGammPoolShare.getShareCurrency(
      pool.id
    );
    userUnlockingAssets = queryOsmosis.queryLockableDurations.lockableDurations
      .map(
        (duration) => {
          const unlockings = queryOsmosis.queryAccountLocked
            .get(bech32Address)
            .getUnlockingCoinWithDuration(poolShareCurrency, duration);

          return unlockings.map((unlocking) => ({
            ...unlocking,
            duration,
          }));
        },
        [] as {
          duration: Duration;
          amount: CoinPretty;
          endTime: Date;
        }[]
      )
      .flat();
    externalGuages = (ExternalIncentiveGaugeAllowList[pool.id] ?? []).map(
      ({ gaugeId, denom }) => {
        const observableGauge = queryOsmosis.queryGauge.get(gaugeId);
        const currency = chainStore
          .getChain(chainStore.osmosis.chainId)
          .findCurrency(denom);

        return {
          duration: observableGauge.lockupDuration.humanize(),
          rewardAmount: currency
            ? new CoinPretty(
                currency,
                observableGauge.getCoin(currency)
              ).moveDecimalPointRight(currency.coinDecimals)
            : undefined,
          remainingEpochs: observableGauge.remainingEpoch,
        };
      }
    );
    const lockableDurations =
      queryOsmosis.queryLockableDurations.lockableDurations;
    guages = lockableDurations.map((duration) => {
      const guageId =
        queryOsmosis.queryIncentivizedPools.getIncentivizedGaugeId(
          pool.id,
          duration
        )!;
      return queryOsmosis.queryGauge.get(guageId);
    });

    const isSuperfluid = queryOsmosis.querySuperfluidPools.isSuperfluidPool(
      pool.id
    );
    const upgradeableLPLockIds:
      | {
          amount: CoinPretty;
          lockIds: string[];
        }
      | undefined =
      lockableDurations.length > 0
        ? queryOsmosis.queryAccountLocked
            .get(bech32Address)
            .getLockedCoinWithDuration(
              poolShareCurrency,
              lockableDurations[lockableDurations.length - 1]
            )
        : undefined;
    const notDelegatedLockedSfsLpShares =
      queryOsmosis.querySuperfluidDelegations
        .getQuerySuperfluidDelegations(bech32Address)
        .getDelegations(poolShareCurrency)?.length === 0 &&
      upgradeableLPLockIds &&
      upgradeableLPLockIds.lockIds.length > 0;
    superfluid = isSuperfluid
      ? notDelegatedLockedSfsLpShares
        ? { upgradeableLPLockIds }
        : {
            delegations: queryOsmosis.querySuperfluidDelegations
              .getQuerySuperfluidDelegations(bech32Address)
              .getDelegations(poolShareCurrency)
              ?.map(({ validator_address, amount }) => {
                const queryValidators =
                  queryCosmos.queryValidators.getQueryStatus(
                    Staking.BondStatus.Bonded
                  );
                const validatorInfo =
                  queryValidators.getValidator(validator_address);
                let superfluidApr = queryCosmos.queryInflation.inflation.mul(
                  queryOsmosis.querySuperfluidOsmoEquivalent.estimatePoolAPROsmoEquivalentMultiplier(
                    pool.id
                  )
                );

                const lockableDurations =
                  queryOsmosis.queryLockableDurations.lockableDurations;

                if (lockableDurations.length > 0) {
                  const poolApr =
                    queryOsmosis.queryIncentivizedPools.computeAPY(
                      pool.id,
                      lockableDurations[lockableDurations.length - 1],
                      priceStore,
                      fiat
                    );
                  superfluidApr = superfluidApr.add(
                    poolApr.moveDecimalPointRight(2).toDec()
                  );
                }

                const commissionRateRaw =
                  validatorInfo?.commission.commission_rates.rate;

                return {
                  validatorName: validatorInfo?.description.moniker,
                  validatorCommission: commissionRateRaw
                    ? new RatePretty(new Dec(commissionRateRaw))
                    : undefined,
                  validatorImgSrc:
                    queryValidators.getValidatorThumbnail(validator_address),
                  apr: new RatePretty(superfluidApr.moveDecimalPointLeft(2)),
                  amount:
                    queryOsmosis.querySuperfluidOsmoEquivalent.calculateOsmoEquivalent(
                      amount
                    ),
                };
              }),
            undelegations: queryOsmosis.querySuperfluidUndelegations
              .getQuerySuperfluidDelegations(bech32Address)
              .getUndelegations(poolShareCurrency)
              ?.map(({ validator_address, amount, end_time }) => ({
                validatorName: queriesStore
                  .get(chainId)
                  .cosmos.queryValidators.getQueryStatus(
                    Staking.BondStatus.Bonded
                  )
                  .getValidator(validator_address)?.description.moniker,
                amount,
                endTime: end_time,
              })),
            superfluidLPShares: queryOsmosis.queryAccountLocked
              .get(bech32Address)
              .getLockedCoinWithDuration(
                poolShareCurrency,
                lockableDurations[lockableDurations.length - 1]
              ),
          }
      : "not-superfluid-pool";
  }

  // eject to pools page if pool does not exist
  useEffect(() => {
    return autorun(() => {
      if (queryOsmosis.queryGammPools.poolExists(poolId as string) === false) {
        router.push("/pools");
      }
    });
  });

  // Manage liquidity + bond LP tokens (modals) state
  const [showManageLiquidityDialog, setShowManageLiquidityDialog] =
    useState(false);
  const [showLockLPTokenModal, setShowLockLPTokenModal] = useState(false);
  const [
    addLiquidityConfig,
    removeLiquidityConfig,
    lockLPTokensConfig,
    lockupGauges,
  ] = useMemo(() => {
    if (pool) {
      return [
        new ObservableAddLiquidityConfig(
          chainStore,
          chainId,
          pool.id,
          bech32Address,
          queriesStore,
          queryOsmosis.queryGammPoolShare,
          queryOsmosis.queryGammPools,
          queriesStore.get(chainId).queryBalances
        ),
        new ObservableRemoveLiquidityConfig(
          chainStore,
          chainId,
          pool.id,
          bech32Address,
          queriesStore,
          queryOsmosis.queryGammPoolShare,
          queryOsmosis.queryGammPools,
          "50"
        ),
        new ObservableAmountConfig(
          chainStore,
          queriesStore,
          chainId,
          bech32Address,
          queryOsmosis.queryGammPoolShare.getShareCurrency(pool.id)
        ),
        queryOsmosis.queryLockableDurations.lockableDurations.map(
          (duration, index, durations) => {
            const apr = pool
              ? queryOsmosis.queryIncentivizedPools.computeAPY(
                  pool.id,
                  duration,
                  priceStore,
                  fiat
                )
              : undefined;

            return {
              id: index.toString(),
              apr: apr ?? new RatePretty(0),
              duration,
              superfluidApr:
                pool &&
                index === durations.length - 1 &&
                queryOsmosis.querySuperfluidPools.isSuperfluidPool(pool.id)
                  ? new RatePretty(
                      queryCosmos.queryInflation.inflation
                        .mul(
                          queryOsmosis.querySuperfluidOsmoEquivalent.estimatePoolAPROsmoEquivalentMultiplier(
                            pool.id
                          )
                        )
                        .moveDecimalPointLeft(2)
                    )
                  : undefined,
            };
          }
        ),
      ];
    }
    return [undefined, undefined, undefined, undefined];
  }, [
    pool,
    chainStore,
    chainId,
    bech32Address,
    queriesStore,
    queryOsmosis,
    queryCosmos,
    priceStore,
    fiat,
  ]);

  const [showSuperfluidValidatorModal, setShowSuperfluidValidatorsModal] =
    useState(false);

  return (
    <main>
      {pool && addLiquidityConfig && removeLiquidityConfig && (
        <ManageLiquidityModal
          isOpen={showManageLiquidityDialog}
          title="Manage Liquidity"
          onRequestClose={() => setShowManageLiquidityDialog(false)}
          addLiquidityConfig={addLiquidityConfig}
          removeLiquidityConfig={removeLiquidityConfig}
          isSendingMsg={account.txTypeInProgress !== ""}
          getChainNetworkName={(coinDenom) =>
            EmbedChainInfos.find((chain) =>
              chain.currencies.find(
                (currency) => currency.coinDenom === coinDenom
              )
            )?.chainName
          }
          getFiatValue={(coin) => priceStore.calculatePrice(coin)}
          onAddLiquidity={async () => {
            try {
              if (
                addLiquidityConfig.isSingleAmountIn &&
                addLiquidityConfig.singleAmountInConfig
              ) {
                await account.osmosis.sendJoinSwapExternAmountInMsg(
                  addLiquidityConfig.poolId,
                  addLiquidityConfig.singleAmountInConfig,
                  undefined,
                  undefined,
                  () => setShowManageLiquidityDialog(false)
                );
              } else if (addLiquidityConfig.shareOutAmount) {
                await account.osmosis.sendJoinPoolMsg(
                  addLiquidityConfig.poolId,
                  addLiquidityConfig.shareOutAmount.toDec().toString(),
                  undefined,
                  undefined,
                  () => setShowManageLiquidityDialog(false)
                );
              }
            } catch (e) {
              console.error(e);
            }
          }}
          onRemoveLiquidity={async () => {
            try {
              await account.osmosis.sendExitPoolMsg(
                removeLiquidityConfig.poolId,
                removeLiquidityConfig.poolShareWithPercentage
                  .toDec()
                  .toString(),
                undefined,
                undefined,
                () => setShowManageLiquidityDialog(false)
              );
            } catch (e) {
              console.error(e);
            }
          }}
        />
      )}
      {lockLPTokensConfig && lockupGauges && (
        <LockTokensModal
          isOpen={showLockLPTokenModal}
          title="Bond LP Tokens"
          onRequestClose={() => setShowLockLPTokenModal(false)}
          isSendingMsg={account.txTypeInProgress !== ""}
          amountConfig={lockLPTokensConfig}
          availableToken={
            pool
              ? queryOsmosis.queryGammPoolShare.getAvailableGammShare(
                  bech32Address,
                  pool.id
                )
              : undefined
          }
          gauges={lockupGauges}
          hasSuperfluidValidator={
            superfluid &&
            typeof superfluid !== "string" &&
            "delegations" in superfluid &&
            superfluid.delegations &&
            superfluid.delegations.length > 0
          }
          onLockToken={async (gaugeId, electSuperfluid) => {
            setShowLockLPTokenModal(false);
            if (electSuperfluid) {
              setShowSuperfluidValidatorsModal(true);
              // `sendLockAndSuperfluidDelegateMsg` will be sent after superfluid modal
            } else {
              const gauge = lockupGauges.find((gauge) => gauge.id === gaugeId);
              try {
                if (gauge) {
                  await account.osmosis.sendLockTokensMsg(
                    gauge.duration.asSeconds(),
                    [
                      {
                        currency: lockLPTokensConfig.sendCurrency,
                        amount: lockLPTokensConfig.amount,
                      },
                    ],
                    undefined,
                    () => setShowLockLPTokenModal(false)
                  );
                } else {
                  console.error("Gauge ID not found:", gaugeId);
                  setShowLockLPTokenModal(false);
                }
              } catch (e) {
                console.error(e);
              }
            }
          }}
        />
      )}
      {superfluid &&
        superfluid !== "not-superfluid-pool" &&
        pool &&
        lockLPTokensConfig && (
          <SuperfluidValidatorModal
            title="Select Superfluid Validator"
            availableBondAmount={
              "upgradeableLPLockIds" in superfluid
                ? superfluid.upgradeableLPLockIds.amount // is delegating amount from existing lockup
                : new CoinPretty(
                    pool.shareCurrency, // is delegating amount from new/pending lockup
                    lockLPTokensConfig.amount !== ""
                      ? lockLPTokensConfig.amount
                      : new Dec(0)
                  )
            }
            isOpen={showSuperfluidValidatorModal}
            onRequestClose={() => setShowSuperfluidValidatorsModal(false)}
            isSendingMsg={account.txTypeInProgress !== ""}
            onSelectValidator={async (validatorAddress) => {
              if (superfluid && typeof superfluid !== "string") {
                if ("upgradeableLPLockIds" in superfluid) {
                  // is delegating existing locked shares
                  try {
                    await account.osmosis.sendSuperfluidDelegateMsg(
                      superfluid.upgradeableLPLockIds.lockIds,
                      validatorAddress,
                      "",
                      () => setShowSuperfluidValidatorsModal(false)
                    );
                  } catch (e) {
                    console.error(e);
                  }
                } else if (
                  "superfluidLPShares" in superfluid &&
                  lockLPTokensConfig
                ) {
                  try {
                    await account.osmosis.sendLockAndSuperfluidDelegateMsg(
                      [
                        {
                          currency: lockLPTokensConfig.currency,
                          amount: lockLPTokensConfig.amount,
                        },
                      ],
                      validatorAddress,
                      "",
                      () => setShowSuperfluidValidatorsModal(false)
                    );
                    // TODO: clear/reset LP lock amount config ??
                  } catch (e) {
                    console.error(e);
                  }
                }
              }
            }}
          />
        )}
      <Overview
        title={
          <MetricLoader className="h-7 w-64" isLoading={!pool}>
            <h5>
              {`Pool #${pool?.id} : ${pool?.poolAssets
                .map((asset) => asset.amount.currency.coinDenom)
                .map((denom) => truncateString(denom, 8))
                .join(" / ")}`}
            </h5>
          </MetricLoader>
        }
        titleButtons={[
          {
            label: "Add / Remove Liquidity",
            onClick: () => setShowManageLiquidityDialog(true),
          },
          { label: "Swap Tokens", onClick: console.log },
        ]}
        primaryOverviewLabels={[
          {
            label: "Pool Liquidity",
            value: (
              <MetricLoader
                className="h-7 w-56"
                isLoading={!pool || !totalValueLocked}
              >
                {totalValueLocked?.toString() || "0"}
              </MetricLoader>
            ),
          },
          {
            label: "My Liquidity",
            value: (
              <MetricLoader className="h-7 " isLoading={!userLockedValue}>
                {userLockedValue?.toString() || "0"}
              </MetricLoader>
            ),
          },
        ]}
        secondaryOverviewLabels={[
          {
            label: "Bonded",
            value: (
              <MetricLoader className="h-4" isLoading={!userBondedValue}>
                {userBondedValue?.toString() || "0"}
              </MetricLoader>
            ),
          },
          {
            label: "Swap Fee",
            value: (
              <MetricLoader className="h-4" isLoading={!pool}>
                {pool?.swapFee.toString() || "0"}
              </MetricLoader>
            ),
          },
        ]}
        bgImageUrl="/images/osmosis-guy-in-lab.png"
      />
      <section className="bg-surface">
        <div className="max-w-container mx-auto p-10">
          <div className="flex place-content-between">
            <div className="max-w-md">
              <div className="flex gap-3">
                <h5>Liquidity Mining</h5>
                {superfluid && superfluid !== "not-superfluid-pool" && (
                  <div className="bg-superfluid rounded-full px-4 py-1 text-xs md:text-base">
                    Superfluid Staking Enabled
                  </div>
                )}
              </div>
              <p className="text-white-mid py-2">
                Bond liquidity to various minimum unbonding periods to earn OSMO
                liquidity rewards and swap fees
              </p>
            </div>
            <div className="flex flex-col gap-2 text-right">
              <span className="text-white-mid">Available LP tokens</span>
              <h5>
                <MetricLoader className="h-6" isLoading={!userAvailableValue}>
                  {userAvailableValue?.toString() || "$0"}
                </MetricLoader>
              </h5>
              <Button
                className="h-8"
                onClick={() => setShowLockLPTokenModal(true)}
              >
                Start Earning
              </Button>
            </div>
          </div>
          {pool &&
            guages &&
            queryOsmosis.queryIncentivizedPools.isIncentivized(pool.id) && (
              <>
                <div className="flex gap-9 place-content-between pt-10">
                  {externalGuages?.map(
                    (
                      { rewardAmount, duration: durationDays, remainingEpochs },
                      index
                    ) => (
                      <PoolGaugeBonusCard
                        key={index}
                        bonusValue={
                          rewardAmount?.maxDecimals(0).trim(true).toString() ??
                          "0"
                        }
                        days={durationDays}
                        remainingEpochs={remainingEpochs.toString()}
                      />
                    )
                  )}
                </div>
                <div className="flex gap-9 place-content-between pt-10">
                  {guages.map((guage, i) => (
                    <PoolGaugeCard
                      key={i}
                      days={guage.lockupDuration.humanize()}
                      apr={queryOsmosis.queryIncentivizedPools
                        .computeAPY(
                          pool.id,
                          guage.lockupDuration,
                          priceStore,
                          fiat
                        )
                        .maxDecimals(2)
                        .toString()}
                      isLoading={
                        guage.isFetching ||
                        queryOsmosis.queryIncentivizedPools.isAprFetching
                      }
                      superfluidApr={
                        guages &&
                        i === guages.length - 1 &&
                        superfluid &&
                        superfluid !== "not-superfluid-pool"
                          ? new RatePretty(
                              queryCosmos.queryInflation.inflation
                                .mul(
                                  queryOsmosis.querySuperfluidOsmoEquivalent.estimatePoolAPROsmoEquivalentMultiplier(
                                    pool.id
                                  )
                                )
                                .moveDecimalPointLeft(2)
                            )
                              .maxDecimals(0)
                              .trim(true)
                              .toString()
                          : undefined
                      }
                    />
                  ))}
                </div>
              </>
            )}
        </div>
        {superfluid &&
          superfluid !== "not-superfluid-pool" &&
          ("upgradeableLPLockIds" in superfluid ||
            ("delegations" in superfluid &&
              superfluid.delegations &&
              superfluid.delegations.length > 0)) && (
            <div className="max-w-container mx-auto p-10 flex flex-col gap-4">
              <h5>Superfluid Staking</h5>
              {"upgradeableLPLockIds" in superfluid ? (
                <div className="mt-5 bg-card p-5 rounded-2xl flex items-center justify-between font-body">
                  <div>
                    <div className="text-base font-semibold text-white-high">
                      Superfluid Staking Inactive
                    </div>
                    <div className="mt-2 text-sm font-medium text-iconDefault">
                      You have superfluid eligible bonded liquidity.
                      <br />
                      Choose a Superfluid Staking validator to earn additional
                      rewards.
                    </div>
                  </div>
                  <button
                    className="bg-superfluid rounded-lg py-2 px-8 text-white-high font-semibold text-sm shadow-elevation-04dp"
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();

                      setShowSuperfluidValidatorsModal(true);
                    }}
                  >
                    Go Superfluid
                  </button>
                </div>
              ) : (
                "delegations" in superfluid &&
                superfluid.delegations?.map(
                  (
                    {
                      validatorName,
                      validatorCommission,
                      validatorImgSrc,
                      amount,
                      apr,
                    },
                    index
                  ) => (
                    <div
                      key={index}
                      className="w-full p-0.5 rounded-xl bg-superfluid"
                    >
                      <div className="flex flex-col w-full gap-1 bg-card rounded-xl py-5 px-7">
                        <div className="flex place-content-between text-subtitle1">
                          <span>My Superfluid Validator</span>
                          <span>My Superfluid Delegation</span>
                        </div>
                        <hr className="my-3 text-white-faint" />
                        <div className="flex place-content-between">
                          <div className="flex gap-3">
                            <div className="rounded-full border border-enabledGold w-14 h-14 p-1 flex shrink-0">
                              {validatorImgSrc && (
                                <img
                                  className="rounded-full"
                                  alt="validator image"
                                  src={validatorImgSrc}
                                />
                              )}
                            </div>
                            <div className="flex flex-col place-content-evenly">
                              <span className="text-lg text-white-high">
                                <MetricLoader isLoading={!validatorName}>
                                  {validatorName}
                                </MetricLoader>
                              </span>
                              <span className="text-sm text-iconDefault">
                                Commission -{" "}
                                <MetricLoader isLoading={!validatorCommission}>
                                  {validatorCommission?.toString() ?? ""}
                                </MetricLoader>
                              </span>
                            </div>
                          </div>
                          <div>
                            <h6 className="text-white-high">
                              ~{amount.maxDecimals(0).trim(true).toString()}
                            </h6>
                            <span className="float-right text-sm text-iconDefault">
                              ~{apr.maxDecimals(0).trim(true).toString()} APR
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                )
              )}
            </div>
          )}
        <div className="max-w-container mx-auto p-10">
          <h6>My Bondings</h6>
          <Table<
            BaseCell & {
              duration: Duration;
              amount: CoinPretty;
              apr?: RatePretty;
              lockIds: string[];
              isSuperfluidDuration: boolean;
            }
          >
            className="w-full my-5"
            columnDefs={[
              {
                display: "Unbonding Duration",
                displayCell:
                  superfluid && superfluid !== "not-superfluid-pool"
                    ? ({ value, isSuperfluidDuration }) => (
                        <div className="flex gap-3">
                          <span>{value ?? ""}</span>
                          {isSuperfluidDuration && (
                            <Image
                              alt="superfluid"
                              src="/icons/superfluid-osmo.svg"
                              height={20}
                              width={20}
                            />
                          )}
                        </div>
                      )
                    : undefined,
              },
              { display: "Current APR" },
              { display: "Amount" },
              {
                display: "Action",
                displayCell: ({ amount, lockIds, isSuperfluidDuration }) => (
                  <Button
                    type="arrow"
                    size="xs"
                    disabled={
                      account.txTypeInProgress !== "" ||
                      amount?.toDec().equals(new Dec(0))
                    }
                    onClick={async () => {
                      if (!lockIds) return;
                      try {
                        if (isSuperfluidDuration) {
                          const blockGasLimitLockIds = lockIds.slice(0, 4);

                          for (const lockId of blockGasLimitLockIds) {
                            await queryOsmosis.querySyntheticLockupsByLockId
                              .get(lockId)
                              .waitFreshResponse();
                          }

                          await account.osmosis.sendBeginUnlockingMsgOrSuperfluidUnbondLockMsgIfSyntheticLock(
                            blockGasLimitLockIds.map((lockId) => ({
                              lockId,
                              isSyntheticLock:
                                queryOsmosis.querySyntheticLockupsByLockId.get(
                                  lockId
                                ).isSyntheticLock === true,
                            }))
                          );
                        } else {
                          const blockGasLimitLockIds = lockIds.slice(0, 10);
                          await account.osmosis.sendBeginUnlockingMsg(
                            blockGasLimitLockIds
                          );
                        }
                      } catch (e) {
                        console.error(e);
                      }
                    }}
                  >
                    Unbond All
                  </Button>
                ),
              },
            ]}
            data={
              userLockedAssets?.map((lockedAsset, index) => [
                {
                  value: lockedAsset.duration.humanize(),
                  isSuperfluidDuration:
                    index === (userLockedAssets?.length ?? 0) - 1 &&
                    superfluid &&
                    typeof superfluid !== "string" &&
                    "delegations" in superfluid &&
                    superfluid.delegations &&
                    superfluid.delegations.length > 0,
                }, // Unbonding Duration
                {
                  value:
                    lockedAsset.apr?.maxDecimals(2).trim(true).toString() ??
                    "0%",
                }, // Current APR
                {
                  value: lockedAsset.amount
                    .maxDecimals(6)
                    .trim(true)
                    .toString(),
                }, // Amount
                {
                  ...lockedAsset,
                  value: lockedAsset.duration.humanize(),
                  isSuperfluidDuration:
                    index === (userLockedAssets?.length ?? 0) - 1 &&
                    superfluid &&
                    typeof superfluid !== "string" &&
                    "delegations" in superfluid &&
                    superfluid.delegations &&
                    superfluid.delegations.length > 0,
                }, // Unbond All button
              ]) ?? [[{ value: "" }], [{ value: "" }], [{ value: "" }]]
            }
          />
        </div>
        {userUnlockingAssets && userUnlockingAssets.length > 0 && (
          <div className="max-w-container mx-auto p-10">
            <h6>Unbondings</h6>
            <Table
              className="w-full my-5"
              columnDefs={[
                {
                  display: "Unbonding Duration",
                  className: "w-1/3",
                },
                { display: "Amount", className: "w-1/3" },
                {
                  display: "Unbonding Complete",
                  className: "w-1/3",
                },
              ]}
              data={
                userUnlockingAssets?.map(({ duration, amount, endTime }) => [
                  {
                    value: duration.humanize(),
                  },
                  {
                    value: amount.maxDecimals(6).trim(true).toString(),
                  },
                  {
                    value: moment(endTime).fromNow(),
                  },
                ]) ?? [[{ value: "" }], [{ value: "" }], [{ value: "" }]]
              }
            />
          </div>
        )}
        {superfluid &&
          superfluid !== "not-superfluid-pool" &&
          !("upgradeableLPLockIds" in superfluid) &&
          superfluid.undelegations &&
          superfluid.undelegations.length > 0 && (
            <div className="max-w-container mx-auto p-10">
              <h6>Superfluid Unbondings</h6>
              <Table
                className="w-full my-5 justify-left"
                columnDefs={[
                  {
                    display: "Validator",
                    className: "w-1/3",
                  },
                  { display: "Amount", className: "w-1/3" },
                  {
                    display: "Unbonding Complete",
                    className: "w-1/3",
                  },
                ]}
                data={
                  superfluid.undelegations?.map(
                    ({ validatorName, amount, endTime }) => [
                      {
                        value: validatorName ?? "",
                      },
                      {
                        value: amount.maxDecimals(6).trim(true).toString(),
                      },
                      {
                        value: moment(endTime).fromNow(),
                      },
                    ]
                  ) ?? [[{ value: "" }], [{ value: "" }], [{ value: "" }]]
                }
              />
            </div>
          )}
        <div className="max-w-container mx-auto p-10">
          <h5>Pool Catalyst</h5>
          <div className="flex gap-5 my-5">
            {(userPoolAssets ?? [undefined, undefined]).map(
              (userAsset, index) => (
                <PoolCatalystCard
                  key={index}
                  colorKey={Number(pool?.id ?? "0") + index}
                  isLoading={!pool || !userPoolAssets}
                  className="w-1/2 max-w-md"
                  percentDec={userAsset?.ratio.toString()}
                  tokenMinimalDenom={userAsset?.asset.currency.coinDenom}
                  metrics={[
                    {
                      label: "Total amount",
                      value: (
                        <MetricLoader isLoading={!userPoolAssets}>
                          {pool?.poolAssets
                            .find(
                              (asset) =>
                                asset.amount.currency.coinDenom ===
                                userAsset?.asset.currency.coinDenom
                            )
                            ?.amount.maxDecimals(0)
                            .toString() ?? "0"}
                        </MetricLoader>
                      ),
                    },
                    {
                      label: "My amount",
                      value: (
                        <MetricLoader isLoading={!userPoolAssets}>
                          {userAsset?.asset.maxDecimals(0).toString()}
                        </MetricLoader>
                      ),
                    },
                  ]}
                />
              )
            )}
          </div>
        </div>
      </section>
    </main>
  );
});

export default Pool;