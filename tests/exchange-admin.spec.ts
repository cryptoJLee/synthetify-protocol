import * as anchor from '@project-serum/anchor'
import { Program } from '@project-serum/anchor'
import { Token } from '@solana/spl-token'
import { Account, PublicKey, Transaction } from '@solana/web3.js'
import { assert } from 'chai'
import { BN, Exchange, Network, signAndSend } from '@synthetify/sdk'

import {
  createAssetsList,
  createToken,
  EXCHANGE_ADMIN,
  SYNTHETIFY_ECHANGE_SEED,
  assertThrowsAsync
} from './utils'
import { createPriceFeed } from './oracleUtils'
import { ERRORS } from '@synthetify/sdk/src/utils'
import { Collateral } from '../sdk/lib/exchange'

describe('staking', () => {
  const provider = anchor.Provider.local()
  const connection = provider.connection
  const exchangeProgram = anchor.workspace.Exchange as Program
  const managerProgram = anchor.workspace.Manager as Program
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
  let reserveAccount: PublicKey
  let CollateralTokenMinter: Account = wallet
  let nonce: number
  const stakingRoundLength = 10
  const amountPerRound = new BN(100)

  let initialCollateralPrice = 2
  before(async () => {
    const [_exchangeAuthority, _nonce] = await anchor.web3.PublicKey.findProgramAddress(
      [SYNTHETIFY_ECHANGE_SEED],
      exchangeProgram.programId
    )
    nonce = _nonce
    exchangeAuthority = _exchangeAuthority
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
    reserveAccount = await collateralToken.createAccount(exchangeAuthority)

    // @ts-expect-error
    exchange = new Exchange(
      connection,
      Network.LOCAL,
      provider.wallet,
      exchangeAuthority,
      exchangeProgram.programId
    )

    const data = await createAssetsList({
      snyLiquidationFund: liquidationAccount,
      snyReserve: reserveAccount,
      exchangeAuthority,
      collateralToken,
      collateralTokenFeed,
      connection,
      wallet,
      exchange
    })
    assetsList = data.assetsList
    usdToken = data.usdToken

    await exchange.init({
      admin: EXCHANGE_ADMIN.publicKey,
      assetsList,
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
  })
  it('Initialize', async () => {
    const state = await exchange.getState()
    // Check initialized addreses
    assert.ok(state.admin.equals(EXCHANGE_ADMIN.publicKey))
    assert.ok(state.halted === false)
    assert.ok(state.assetsList.equals(assetsList))
    // Check initialized parameters
    assert.ok(state.nonce === nonce)
    assert.ok(state.maxDelay === 0)
    assert.ok(state.fee === 300)
    assert.ok(state.healthFactor === 50)
    assert.ok(state.liquidationBuffer === 172800)
    assert.ok(state.debtShares.eq(new BN(0)))
  })
  describe('#setLiquidationBuffer()', async () => {
    it('Fail without admin signature', async () => {
      const newLiquidationBuffer = 999
      const ix = await exchange.setLiquidationBufferInstruction(newLiquidationBuffer)
      await assertThrowsAsync(
        signAndSend(new Transaction().add(ix), [wallet], connection),
        ERRORS.SIGNATURE
      )
      const state = await exchange.getState()
      assert.ok(state.liquidationBuffer !== newLiquidationBuffer)
    })
    it('change value', async () => {
      const newLiquidationBuffer = 999
      const ix = await exchange.setLiquidationBufferInstruction(newLiquidationBuffer)
      await signAndSend(new Transaction().add(ix), [wallet, EXCHANGE_ADMIN], connection)
      const state = await exchange.getState()
      assert.ok(state.liquidationBuffer === newLiquidationBuffer)
    })
  })
  describe('#setLiquidationPenalties()', async () => {
    it('Fail without admin signature', async () => {
      const penaltyToExchange = 10
      const penaltyToLiquidator = 10
      const ix = await exchange.setLiquidationPenaltiesInstruction({
        penaltyToExchange,
        penaltyToLiquidator
      })
      await assertThrowsAsync(
        signAndSend(new Transaction().add(ix), [wallet], connection),
        ERRORS.SIGNATURE
      )
      const state = await exchange.getState()
      assert.ok(state.penaltyToExchange !== penaltyToExchange)
      assert.ok(state.penaltyToLiquidator !== penaltyToLiquidator)
    })
    it('Change values', async () => {
      const penaltyToExchange = 10
      const penaltyToLiquidator = 10
      const ix = await exchange.setLiquidationPenaltiesInstruction({
        penaltyToExchange,
        penaltyToLiquidator
      })
      await signAndSend(new Transaction().add(ix), [wallet, EXCHANGE_ADMIN], connection)

      const state = await exchange.getState()
      assert.ok(state.penaltyToExchange == penaltyToExchange)
      assert.ok(state.penaltyToLiquidator == penaltyToLiquidator)
    })
  })
  describe('#setFee()', async () => {
    it('Fail without admin signature', async () => {
      const newFee = 999
      const ix = await exchange.setFeeInstruction(newFee)
      await assertThrowsAsync(
        signAndSend(new Transaction().add(ix), [wallet], connection),
        ERRORS.SIGNATURE
      )
      const state = await exchange.getState()
      assert.ok(state.fee !== newFee)
    })
    it('change value', async () => {
      const newFee = 999
      const ix = await exchange.setFeeInstruction(newFee)
      await signAndSend(new Transaction().add(ix), [wallet, EXCHANGE_ADMIN], connection)
      const state = await exchange.getState()
      assert.ok(state.fee === newFee)
    })
  })
  describe('#setMaxDelay()', async () => {
    it('Fail without admin signature', async () => {
      const newMaxDelay = 999
      const ix = await exchange.setMaxDelayInstruction(newMaxDelay)
      await assertThrowsAsync(
        signAndSend(new Transaction().add(ix), [wallet], connection),
        ERRORS.SIGNATURE
      )
      const state = await exchange.getState()
      assert.ok(state.maxDelay !== newMaxDelay)
    })
    it('change value', async () => {
      const newMaxDelay = 999
      const ix = await exchange.setMaxDelayInstruction(newMaxDelay)
      await signAndSend(new Transaction().add(ix), [wallet, EXCHANGE_ADMIN], connection)
      const state = await exchange.getState()
      assert.ok(state.maxDelay === newMaxDelay)
    })
  })
  describe('#setHalted()', async () => {
    it('Fail without admin signature', async () => {
      const halted = true
      const ix = await exchange.setHaltedInstruction(halted)
      await assertThrowsAsync(
        signAndSend(new Transaction().add(ix), [wallet], connection),
        ERRORS.SIGNATURE
      )
      const state = await exchange.getState()
      assert.ok(state.halted !== halted)
    })
    it('change value', async () => {
      const halted = true
      const ix = await exchange.setHaltedInstruction(halted)
      await signAndSend(new Transaction().add(ix), [wallet, EXCHANGE_ADMIN], connection)
      const state = await exchange.getState()
      assert.ok(state.halted === halted)
    })
  })
  describe('#setHealthFactor()', async () => {
    it('Fail without admin signature', async () => {
      const healthFactor = 70
      const ix = await exchange.setHealthFactorInstruction(new BN(healthFactor))
      await assertThrowsAsync(
        signAndSend(new Transaction().add(ix), [wallet], connection),
        ERRORS.SIGNATURE
      )
      const state = await exchange.getState()
      assert.ok(state.healthFactor !== healthFactor)
    })
    it('change value', async () => {
      const healthFactor = 70
      const ix = await exchange.setHealthFactorInstruction(new BN(healthFactor))
      await signAndSend(new Transaction().add(ix), [wallet, EXCHANGE_ADMIN], connection)
      const state = await exchange.getState()
      assert.ok(state.healthFactor === healthFactor)
    })
  })
  describe('#setStakingAmountPerRound()', async () => {
    it('Fail without admin signature', async () => {
      const amount = new BN(12399)
      const ix = await exchange.setStakingAmountPerRound(amount)
      await assertThrowsAsync(
        signAndSend(new Transaction().add(ix), [wallet], connection),
        ERRORS.SIGNATURE
      )
      const state = await exchange.getState()
      assert.ok(!state.staking.amountPerRound.eq(amount))
    })
    it('change value', async () => {
      const amount = new BN(12399)
      const ix = await exchange.setStakingAmountPerRound(amount)
      await signAndSend(new Transaction().add(ix), [wallet, EXCHANGE_ADMIN], connection)
      const state = await exchange.getState()
      assert.ok(state.staking.amountPerRound.eq(amount))
    })
  })
  describe('#setStakingRoundLength()', async () => {
    it('Fail without admin signature', async () => {
      const length = 999912
      const ix = await exchange.setStakingRoundLength(length)
      await assertThrowsAsync(
        signAndSend(new Transaction().add(ix), [wallet], connection),
        ERRORS.SIGNATURE
      )
      const state = await exchange.getState()
      assert.ok(state.staking.roundLength !== length)
    })
    it('change value', async () => {
      const length = 999912
      const ix = await exchange.setStakingRoundLength(length)
      await signAndSend(new Transaction().add(ix), [wallet, EXCHANGE_ADMIN], connection)
      const state = await exchange.getState()
      assert.ok(state.staking.roundLength === length)
    })
  })
  describe('#setAsCollateral()', async () => {
    it('Fail without admin signature', async () => {
      // Creating needed accounts
      const someToken = await createToken({
        connection,
        payer: wallet,
        mintAuthority: exchangeAuthority,
        decimals: 8
      })

      const someFeed = await createPriceFeed({
        oracleProgram,
        initPrice: 4,
        expo: -8
      })

      await exchange.addNewAsset({
        assetsAdmin: EXCHANGE_ADMIN,
        assetsList,
        maxSupply: new BN(10).pow(new BN(18)),
        tokenAddress: someToken.publicKey,
        tokenDecimals: 8,
        tokenFeed: someFeed
      })

      // Collateral structure
      const someCollateral: Collateral = {
        isCollateral: true,
        collateralAddress: someToken.publicKey,
        reserveAddress: await someToken.createAccount(exchangeAuthority),
        liquidationFund: await someToken.createAccount(exchangeAuthority),
        reserveBalance: new BN(0),
        collateralRatio: 50,
        decimals: 8
      }

      // Setting collateral
      const ix = await exchange.setAsCollateralInstruction({
        collateral: someCollateral,
        signer: EXCHANGE_ADMIN.publicKey,
        assetsList,
        collateralFeed: someFeed
      })

      await assertThrowsAsync(
        signAndSend(new Transaction().add(ix), [wallet], connection),
        ERRORS.SIGNATURE
      )
    })
    it('change value', async () => {
      // Creating needed accounts
      const someToken = await createToken({
        connection,
        payer: wallet,
        mintAuthority: exchangeAuthority,
        decimals: 8
      })

      const someFeed = await createPriceFeed({
        oracleProgram,
        initPrice: 4,
        expo: -8
      })

      await exchange.addNewAsset({
        assetsAdmin: EXCHANGE_ADMIN,
        assetsList,
        maxSupply: new BN(10).pow(new BN(18)),
        tokenAddress: someToken.publicKey,
        tokenDecimals: 8,
        tokenFeed: someFeed
      })

      // Collateral structure
      const someCollateral: Collateral = {
        isCollateral: true,
        collateralAddress: someToken.publicKey,
        reserveAddress: await someToken.createAccount(exchangeAuthority),
        liquidationFund: await someToken.createAccount(exchangeAuthority),
        reserveBalance: new BN(0),
        collateralRatio: 50,
        decimals: 8
      }

      // Setting collateral
      const ix = await exchange.setAsCollateralInstruction({
        collateral: someCollateral,
        signer: EXCHANGE_ADMIN.publicKey,
        assetsList,
        collateralFeed: someFeed
      })

      await signAndSend(new Transaction().add(ix), [wallet, EXCHANGE_ADMIN], connection)

      // Getting data After
      const assetData = await exchange.getAssetsList(assetsList)
      const lastAsset = assetData.assets[assetData.head - 1].collateral

      // Check if collateral is set on the right asset
      assert.ok(assetData.assets[assetData.head - 1].feedAddress.equals(someFeed))

      // Check collateral feed
      assert.ok(lastAsset.isCollateral == someCollateral.isCollateral)
      assert.ok(lastAsset.collateralAddress.equals(someCollateral.collateralAddress))
      assert.ok(lastAsset.reserveAddress.equals(someCollateral.reserveAddress))
      assert.ok(lastAsset.reserveBalance.eq(someCollateral.reserveBalance))
      assert.ok(lastAsset.collateralRatio == someCollateral.collateralRatio)
      assert.ok(lastAsset.decimals == someCollateral.decimals)
    })
  })
})
