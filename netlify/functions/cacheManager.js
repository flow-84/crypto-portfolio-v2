require('dotenv').config();

const axios = require('axios');
const { getPortfolio, savePortfolio } = require('@sebastienrousseau/crypto-cli');

const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
const API_CALL_INTERVAL = 30 * 1000; // 30 seconds between full CoinGecko API calls

let portfolioCache = {}; // In-memory cache for portfolio data with live prices
let lastApiCallTime = 0;

// Function to retry Axios requests with exponential backoff
async function retryAxios(url, config, retries = 5, delay = 1000) {
  try {
    return await axios.get(url, config);
  } catch (error) {
    if (error.response && error.response.status === 429 && retries > 0) {
      console.warn(`Rate limit hit. Retrying in ${delay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryAxios(url, config, retries - 1, delay * 2);
    } else {
      throw error;
    }
  }
}

async function fetchAndCachePrices() {
  const now = Date.now();
  if (now - lastApiCallTime < API_CALL_INTERVAL) {
    console.log('Skipping CoinGecko API call due to rate limit interval.');
    return;
  }

  console.log('Fetching latest prices from CoinGecko...');
  lastApiCallTime = now;

  try {
    const portfolio = await getPortfolio();
    const coinIds = portfolio.map(item => item.coin);

    if (coinIds.length === 0) {
      portfolioCache = {};
      await savePortfolio([]); // Ensure portfolio.json is empty if no coins
      return;
    }

    const response = await retryAxios(`${COINGECKO_API_BASE}/coins/markets`, {
      params: {
        vs_currency: 'usd',
        ids: coinIds.join(','),
        sparkline: false,
        price_change_percentage: '1h,24h,7d',
      },
    });

    const liveCoinData = {};
    response.data.forEach(coin => {
      liveCoinData[coin.id] = coin;
    });

    const updatedPortfolio = [];
    for (const item of portfolio) {
      const coin = liveCoinData[item.coin];
      if (coin && coin.current_price) {
        item.lastPrice = {
          usd: coin.current_price,
          timestamp: Date.now(),
        };
        item.name = coin.name;
        item.symbol = coin.symbol;
      }
      updatedPortfolio.push(item);
    }

    await savePortfolio(updatedPortfolio);
    portfolioCache = updatedPortfolio;
    console.log('Portfolio cache updated successfully.');
  } catch (error) {
    console.error('Error fetching and caching prices:', error.message);
  }
}

// Initialize cache and start periodic updates
async function initCacheManager() {
  fetchAndCachePrices(); // Initial fetch (non-blocking)
  setInterval(fetchAndCachePrices, API_CALL_INTERVAL); // Periodic updates
}

function getCachedPortfolio() {
  return portfolioCache;
}

function updatePortfolioCache(newPortfolio) {
  portfolioCache = newPortfolio;
}

async function fetchCoinPrice(coinId) {
  try {
    const response = await retryAxios(`${COINGECKO_API_BASE}/coins/markets`, {
      params: {
        vs_currency: 'usd',
        ids: coinId,
        sparkline: false,
        price_change_percentage: '1h,24h,7d',
      },
    });

    if (response.data && response.data.length > 0) {
      const coin = response.data[0];
      const portfolio = await getPortfolio();
      const updatedPortfolio = portfolio.map(item => {
        if (item.coin === coinId) {
          item.lastPrice = {
            usd: coin.current_price,
            timestamp: Date.now(),
          };
          item.name = coin.name;
          item.symbol = coin.symbol;
        }
        return item;
      });
      await savePortfolio(updatedPortfolio);
      portfolioCache = updatedPortfolio;
    }
  } catch (error) {
    console.error(`Error fetching price for ${coinId}:`, error.message);
  }
}

module.exports = { initCacheManager, getCachedPortfolio, updatePortfolioCache, fetchCoinPrice };
