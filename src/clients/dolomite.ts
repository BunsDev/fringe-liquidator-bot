/* eslint-disable no-shadow */
import { BigNumber } from '@dolomite-exchange/v2-protocol'
import { decimalToString } from '@dolomite-exchange/v2-protocol/dist/src/lib/Helpers';
import { GraphqlAccount, GraphqlMarket } from '../lib/graphql-types';
import {
  ApiAccount, ApiBalance, ApiMarket, MarketIndex,
} from '../lib/api-types';
import { dolomite } from '../helpers/web3';

// @ts-ignore
// Needed because of the "cannot use import statement outside a module" error
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function getAccounts(marketIds: number[], query: string): Promise<{ accounts: ApiAccount[] }> {
  const marketIndexPromises = marketIds
    .map<Promise<MarketIndex>>(async marketId => {
    const {
      borrow,
      supply,
    } = await dolomite.contracts.soloMargin.methods.getMarketCurrentIndex(marketId).call();
    return {
      marketId,
      borrow: new BigNumber(borrow),
      supply: new BigNumber(supply),
    }
  })

  const marketIndexMap = await Promise.all(marketIndexPromises)
    .then(marketIndices => marketIndices.reduce<{ [marketId: number]: MarketIndex }>((memo, marketIndex) => {
      memo[marketIndex.marketId] = marketIndex
      return memo
    }, {}))

  const accounts: any = await fetch(`${process.env.SUBGRAPH_URL}`, {
    method: 'POST',
    body: JSON.stringify({
      query,
      variables: null,
    }),
    headers: {
      'content-type': 'application/json',
    },
  })
    .then(response => response.json())
    .then((response: any) => response.data.marginAccounts as GraphqlAccount[])
    .then(graphqlAccounts => graphqlAccounts.map<ApiAccount>(account => {
      const balances = account.tokenValues.reduce<{ [marketNumber: string]: ApiBalance }>((memo, value) => {
        const tokenBase = new BigNumber('10').pow(value.token.decimals)
        const valuePar = new BigNumber(value.valuePar).times(tokenBase).toFixed(0)
        const indexObject = marketIndexMap[value.token.marketId]
        const index = new BigNumber(valuePar).lt('0') ? indexObject.borrow : indexObject.supply
        memo[value.token.marketId] = {
          marketId: Number(value.token.marketId),
          tokenSymbol: value.token.symbol,
          tokenAddress: value.token.id,
          par: valuePar,
          wei: new BigNumber(valuePar).multipliedBy(index).div('1000000000000000000').toFixed(0),
          expiresAt: value.expirationTimestamp ? new BigNumber(value.expirationTimestamp) : undefined,
          expiryAddress: value.expiryAddress,
        }
        return memo
      }, {})
      return {
        id: `${account.user.id}-${account.accountNumber}`,
        owner: account.user.id,
        number: account.accountNumber,
        balances,
      }
    }));

  return { accounts: accounts as ApiAccount[] };
}

export async function getLiquidatableDolomiteAccounts(
  marketIds: number[],
): Promise<{ accounts: ApiAccount[] }> {
  const query = `{
                marginAccounts(where: { hasBorrowedValue: true }) {
                  id
                  user {
                    id
                  }
                  accountNumber
                  tokenValues {
                    token {
                      marketId
                      decimals
                    }
                    valuePar
                    expirationTimestamp
                    expiryAddress
                  }
                }
              }`
  return getAccounts(marketIds, query)
}

export async function getExpiredAccounts(
  marketIds: number[],
): Promise<{ accounts: ApiAccount[] }> {
  const query = `{
                marginAccounts(where: { hasBorrowedValue: true, hasExpiration: true }) {
                  id
                  user {
                    id
                  }
                  accountNumber
                  tokenValues {
                    token {
                      marketId
                      symbol
                      decimals
                    }
                    valuePar
                    expirationTimestamp
                    expiryAddress
                  }
                }
              }`
  return getAccounts(marketIds, query)
}

export async function getDolomiteMarkets(): Promise<{ markets: ApiMarket[] }> {
  const { data }: any = await fetch(`${process.env.SUBGRAPH_URL}`, {
    method: 'POST',
    body: JSON.stringify({
      query: `{
                marketRiskInfos {
                  id
                  token {
                    marketId
                    symbol
                    decimals
                  }
                  marginPremium
                  liquidationRewardPremium
                }
              }`,
      variables: null,
    }),
    headers: {
      'content-type': 'application/json',
    },
  }).then(response => response.json());

  const markets = (data.marketRiskInfos as GraphqlMarket[]).map<Promise<ApiMarket>>(async market => {
    const oraclePriceResult = await dolomite.contracts.soloMargin.methods.getMarketPrice(market.id).call()
    return {
      id: Number(market.id),
      tokenAddress: market.token.id,
      oraclePrice: oraclePriceResult.value,
      marginPremium: decimalToString(market.marginPremium),
      liquidationRewardPremium: decimalToString(market.liquidationRewardPremium),
    }
  })

  return { markets: await Promise.all(markets) };
}
