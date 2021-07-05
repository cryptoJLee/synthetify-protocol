import * as anchor from '@project-serum/anchor'
import { Program } from '@project-serum/anchor'
import { Token } from '@solana/spl-token'
import { Account, PublicKey } from '@solana/web3.js'
import { assert } from 'chai'
import { BN, Exchange, Network } from '@synthetify/sdk'

import {
  createAssetsList,
  createToken,
  EXCHANGE_ADMIN,
  tou64,
  SYNTHETIFY_ECHANGE_SEED,
  createAccountWithCollateralAndMaxMintUsd,
  createAccountWithMultipleCollaterals,
  skipToSlot,
  mulByPercentage
} from './utils'
import { createPriceFeed } from './oracleUtils'

describe('liquidation', () => {
  const provider = anchor.Provider.local()
  const connection = provider.connection
  const exchangeProgram = anchor.workspace.Exchange as Program
  let exchange: Exchange

  const oracleProgram = anchor.workspace.Pyth as Program

  // @ts-expect-error
  const wallet = provider.wallet.payer as Account
  let collateralToken: Token
  let usdToken: Token
  let collateralTokenFeed: PublicKey
  let assetsList: PublicKey
  let exchangeAuthority: PublicKey
  let collateralAccount: PublicKey
  let liquidationAccount: PublicKey
  let stakingFundAccount: PublicKey
  let reserveAddress: PublicKey
  let snyLiquidationFund: PublicKey
  let CollateralTokenMinter: Account = wallet
  let nonce: number

  const amountPerRound = new BN(100)
  const stakingRoundLength = 20

  let initialCollateralPrice = 2
  let nextRoundStart: BN

  before(async () => {
    const [_mintAuthority, _nonce] = await anchor.web3.PublicKey.findProgramAddress(
      [SYNTHETIFY_ECHANGE_SEED],
      exchangeProgram.programId
    )
    nonce = _nonce
    exchangeAuthority = _mintAuthority
    collateralTokenFeed = await createPriceFeed({
      oracleProgram,
      initPrice: initialCollateralPrice,
      expo: -6
    })

    collateralToken = await createToken({
      connection,
      payer: wallet,
      mintAuthority: CollateralTokenMinter.publicKey
    })
    collateralAccount = await collateralToken.createAccount(exchangeAuthority)
    liquidationAccount = await collateralToken.createAccount(exchangeAuthority)
    stakingFundAccount = await collateralToken.createAccount(exchangeAuthority)
    reserveAddress = await collateralToken.createAccount(exchangeAuthority)
    snyLiquidationFund = await collateralToken.createAccount(exchangeAuthority)

    // @ts-expect-error
    exchange = new Exchange(
      connection,
      Network.LOCAL,
      provider.wallet,
      exchangeAuthority,
      exchangeProgram.programId
    )

    const data = await createAssetsList({
      exchangeAuthority,
      collateralToken,
      collateralTokenFeed,
      connection,
      wallet,
      exchange,
      snyReserve: reserveAddress,
      snyLiquidationFund
    })
    assetsList = data.assetsList
    usdToken = data.usdToken

    await exchange.init({
      admin: EXCHANGE_ADMIN.publicKey,
      assetsList,
      reserveAddress,
      liquidationAccount,
      collateralToken: collateralToken.publicKey,
      nonce,
      amountPerRound: amountPerRound,
      stakingRoundLength: stakingRoundLength,
      stakingFundAccount: stakingFundAccount
    })
    exchange = await Exchange.build(
      connection,
      Network.LOCAL,
      provider.wallet,
      exchangeAuthority,
      exchangeProgram.programId
    )
    const state = await exchange.getState()
    nextRoundStart = state.staking.nextRound.start
  })
  it('Initialize', async () => {
    const state = await exchange.getState()
    // Check initialized addreses
    assert.ok(state.admin.equals(EXCHANGE_ADMIN.publicKey))
    assert.ok(state.halted === false)
    assert.ok(state.collateralToken.equals(collateralToken.publicKey))
    assert.ok(state.liquidationAccount.equals(liquidationAccount))
    assert.ok(state.collateralAccount.equals(collateralAccount))
    assert.ok(state.assetsList.equals(assetsList))
    // Check initialized parameters
    assert.ok(state.nonce === nonce)
    assert.ok(state.maxDelay === 0)
    assert.ok(state.fee === 300)
    assert.ok(state.liquidationPenalty === 15)
    assert.ok(state.liquidationThreshold === 200)
    assert.ok(state.collateralizationLevel === 1000)
    assert.ok(state.liquidationBuffer === 172800)
    assert.ok(state.debtShares.eq(new BN(0)))
    assert.ok(state.collateralShares.eq(new BN(0)))
    assert.ok(state.staking.fundAccount.equals(stakingFundAccount))
    assert.ok(state.staking.amountPerRound.eq(amountPerRound))
    assert.ok(state.staking.roundLength === stakingRoundLength)
  })
  describe.only('Staking', async () => {
    it('test flow', async () => {
      const slot = await connection.getSlot()
      assert.ok(nextRoundStart.gtn(slot))
      const collateralAmount = new BN(1000 * 1e6)
      const {
        accountOwner,
        exchangeAccount,
        usdTokenAccount,
        userCollateralTokenAccount
      } = await createAccountWithCollateralAndMaxMintUsd({
        reserveAddress: reserveAddress,
        collateralToken,
        exchangeAuthority,
        exchange,
        collateralTokenMintAuthority: CollateralTokenMinter.publicKey,
        amount: collateralAmount,
        usdToken
      })

      const healthFactor = new BN((await exchange.getState()).healthFactor)

      assert.ok(
        (await exchange.getExchangeAccount(exchangeAccount)).userStakingData.nextRoundPoints.eq(
          mulByPercentage(new BN(200 * 1e6), healthFactor)
        )
      )
      assert.ok(nextRoundStart.gtn(await connection.getSlot()))
      // Wait for start of new round
      await skipToSlot(nextRoundStart.toNumber(), connection)
      // Burn should reduce next round stake
      const amountBurn = mulByPercentage(new BN(100 * 1e6), healthFactor)
      await exchange.burn({
        amount: amountBurn,
        exchangeAccount,
        owner: accountOwner.publicKey,
        userTokenAccountBurn: usdTokenAccount,
        signers: [accountOwner]
      })
      assert.ok(nextRoundStart.toNumber() < (await connection.getSlot()))
      const exchangeAccountDataAfterBurn = await exchange.getExchangeAccount(exchangeAccount)

      const amountScaledByHealth = mulByPercentage(new BN(100 * 1e6), healthFactor)

      assert.ok(
        exchangeAccountDataAfterBurn.userStakingData.nextRoundPoints.eq(amountScaledByHealth)
      )
      assert.ok(
        exchangeAccountDataAfterBurn.userStakingData.currentRoundPoints.eq(amountScaledByHealth)
      )
      // Wait for round to end
      const secondRound = nextRoundStart.toNumber() + 1 + stakingRoundLength
      await skipToSlot(secondRound, connection)

      // Claim rewards
      await exchange.claimRewards(exchangeAccount)
      const state = await exchange.getState()
      assert.ok(state.staking.finishedRound.allPoints.eq(amountScaledByHealth))
      assert.ok(state.staking.currentRound.allPoints.eq(amountScaledByHealth))
      assert.ok(state.staking.nextRound.allPoints.eq(amountScaledByHealth))

      assert.ok(state.staking.finishedRound.amount.eq(amountPerRound))
      const exchangeAccountDataRewardClaim = await exchange.getExchangeAccount(exchangeAccount)
      assert.ok(exchangeAccountDataRewardClaim.userStakingData.finishedRoundPoints.eq(new BN(0)))

      assert.ok(
        (await collateralToken.getAccountInfo(userCollateralTokenAccount)).amount.eq(new BN(0))
      )
      // Mint reward
      await collateralToken.mintTo(
        stakingFundAccount,
        CollateralTokenMinter,
        [],
        tou64(amountPerRound)
      )
      await exchange.withdrawRewards({
        exchangeAccount,
        owner: accountOwner.publicKey,
        userTokenAccount: userCollateralTokenAccount,
        signers: [accountOwner]
      })
      assert.ok(
        (await collateralToken.getAccountInfo(userCollateralTokenAccount)).amount.eq(
          exchangeAccountDataRewardClaim.userStakingData.amountToClaim
        )
      )

      const {
        exchangeAccount: exchangeAccount2nd
      } = await createAccountWithCollateralAndMaxMintUsd({
        reserveAddress,
        collateralToken,
        exchangeAuthority,
        exchange,
        collateralTokenMintAuthority: CollateralTokenMinter.publicKey,
        amount: collateralAmount,
        usdToken
      })
      const exchangeAccount2ndData = await exchange.getExchangeAccount(exchangeAccount2nd)
      assert.ok(
        exchangeAccount2ndData.userStakingData.nextRoundPoints.eq(
          mulByPercentage(new BN(200 * 1e6), healthFactor)
        )
      )

      // Wait for nextRound to end
      await skipToSlot(secondRound + stakingRoundLength, connection)

      await exchange.claimRewards(exchangeAccount)
      await exchange.claimRewards(exchangeAccount2nd)
      assert.ok(
        (await exchange.getExchangeAccount(exchangeAccount)).userStakingData.amountToClaim.eq(
          new BN(100)
        )
      )
      assert.ok(
        (await exchange.getExchangeAccount(exchangeAccount2nd)).userStakingData.amountToClaim.eq(
          new BN(0)
        )
      )
      // Wait for nextRound to end
      await skipToSlot(secondRound + 2 * stakingRoundLength, connection)
      await exchange.claimRewards(exchangeAccount)
      await exchange.claimRewards(exchangeAccount2nd)

      const exchangeAccountDataAfterRewards = await exchange.getExchangeAccount(exchangeAccount)
      const exchangeAccount2ndDataAfterRewards = await exchange.getExchangeAccount(
        exchangeAccount2nd
      )
      assert.ok(exchangeAccountDataAfterRewards.userStakingData.amountToClaim.eq(new BN(133)))
      assert.ok(exchangeAccount2ndDataAfterRewards.userStakingData.amountToClaim.eq(new BN(66)))
    })
    it.only('with multiple collaterals', async () => {
      const otherToken = await createToken({
        connection,
        payer: wallet,
        mintAuthority: CollateralTokenMinter.publicKey
      })
      const otherTokenFeed = await createPriceFeed({
        oracleProgram,
        initPrice: initialCollateralPrice,
        expo: -6
      })
      const otherReserveAddress = await otherToken.createAccount(exchangeAuthority)

      const slot = await connection.getSlot()
      assert.ok(nextRoundStart.gtn(slot))
      const collateralAmount = new BN(1000 * 1e6)
      const {
        accountOwner,
        exchangeAccount,
        // usdTokenAccount,
        userCollateralTokenAccount
      } = await createAccountWithMultipleCollaterals({
        reserveAddress: reserveAddress,
        otherReserveAddress,
        collateralToken,
        otherToken: otherToken,
        exchangeAuthority,
        exchange,
        mintAuthority: CollateralTokenMinter.publicKey,
        amount: collateralAmount
        // usdToken
      })

      const healthFactor = new BN((await exchange.getState()).healthFactor)

      //   assert.ok(
      //     (await exchange.getExchangeAccount(exchangeAccount)).userStakingData.nextRoundPoints.eq(
      //       mulByPercentage(new BN(200 * 1e6), healthFactor)
      //     )
      //   )
      //   assert.ok(nextRoundStart.gtn(await connection.getSlot()))
      //   // Wait for start of new round
      //   await skipToSlot(nextRoundStart.toNumber(), connection)
      //   // Burn should reduce next round stake
      //   const amountBurn = mulByPercentage(new BN(100 * 1e6), healthFactor)
      //   await exchange.burn({
      //     amount: amountBurn,
      //     exchangeAccount,
      //     owner: accountOwner.publicKey,
      //     userTokenAccountBurn: usdTokenAccount,
      //     signers: [accountOwner]
      //   })
      //   assert.ok(nextRoundStart.toNumber() < (await connection.getSlot()))
      //   const exchangeAccountDataAfterBurn = await exchange.getExchangeAccount(exchangeAccount)

      //   const amountScaledByHealth = mulByPercentage(new BN(100 * 1e6), healthFactor)

      //   assert.ok(
      //     exchangeAccountDataAfterBurn.userStakingData.nextRoundPoints.eq(amountScaledByHealth)
      //   )
      //   assert.ok(
      //     exchangeAccountDataAfterBurn.userStakingData.currentRoundPoints.eq(amountScaledByHealth)
      //   )
      //   // Wait for round to end
      //   const secondRound = nextRoundStart.toNumber() + 1 + stakingRoundLength
      //   await skipToSlot(secondRound, connection)

      //   // Claim rewards
      //   await exchange.claimRewards(exchangeAccount)
      //   const state = await exchange.getState()
      //   assert.ok(state.staking.finishedRound.allPoints.eq(amountScaledByHealth))
      //   assert.ok(state.staking.currentRound.allPoints.eq(amountScaledByHealth))
      //   assert.ok(state.staking.nextRound.allPoints.eq(amountScaledByHealth))

      //   assert.ok(state.staking.finishedRound.amount.eq(amountPerRound))
      //   const exchangeAccountDataRewardClaim = await exchange.getExchangeAccount(exchangeAccount)
      //   assert.ok(exchangeAccountDataRewardClaim.userStakingData.finishedRoundPoints.eq(new BN(0)))

      //   assert.ok(
      //     (await collateralToken.getAccountInfo(userCollateralTokenAccount)).amount.eq(new BN(0))
      //   )
      //   // Mint reward
      //   await collateralToken.mintTo(
      //     stakingFundAccount,
      //     CollateralTokenMinter,
      //     [],
      //     tou64(amountPerRound)
      //   )
      //   await exchange.withdrawRewards({
      //     exchangeAccount,
      //     owner: accountOwner.publicKey,
      //     userTokenAccount: userCollateralTokenAccount,
      //     signers: [accountOwner]
      //   })
      //   assert.ok(
      //     (await collateralToken.getAccountInfo(userCollateralTokenAccount)).amount.eq(
      //       exchangeAccountDataRewardClaim.userStakingData.amountToClaim
      //     )
      //   )

      //   const {
      //     exchangeAccount: exchangeAccount2nd
      //   } = await createAccountWithCollateralAndMaxMintUsd({
      //     reserveAddress,
      //     collateralToken,
      //     exchangeAuthority,
      //     exchange,
      //     collateralTokenMintAuthority: CollateralTokenMinter.publicKey,
      //     amount: collateralAmount,
      //     usdToken
      //   })
      //   const exchangeAccount2ndData = await exchange.getExchangeAccount(exchangeAccount2nd)
      //   assert.ok(
      //     exchangeAccount2ndData.userStakingData.nextRoundPoints.eq(
      //       mulByPercentage(new BN(200 * 1e6), healthFactor)
      //     )
      //   )

      //   // Wait for nextRound to end
      //   await skipToSlot(secondRound + stakingRoundLength, connection)

      //   await exchange.claimRewards(exchangeAccount)
      //   await exchange.claimRewards(exchangeAccount2nd)
      //   assert.ok(
      //     (await exchange.getExchangeAccount(exchangeAccount)).userStakingData.amountToClaim.eq(
      //       new BN(100)
      //     )
      //   )
      //   assert.ok(
      //     (await exchange.getExchangeAccount(exchangeAccount2nd)).userStakingData.amountToClaim.eq(
      //       new BN(0)
      //     )
      //   )
      //   // Wait for nextRound to end
      //   await skipToSlot(secondRound + 2 * stakingRoundLength, connection)
      //   await exchange.claimRewards(exchangeAccount)
      //   await exchange.claimRewards(exchangeAccount2nd)

      //   const exchangeAccountDataAfterRewards = await exchange.getExchangeAccount(exchangeAccount)
      //   const exchangeAccount2ndDataAfterRewards = await exchange.getExchangeAccount(
      //     exchangeAccount2nd
      //   )
      //   assert.ok(exchangeAccountDataAfterRewards.userStakingData.amountToClaim.eq(new BN(133)))
      //   assert.ok(exchangeAccount2ndDataAfterRewards.userStakingData.amountToClaim.eq(new BN(66)))
    })
  })
})
