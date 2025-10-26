require('dotenv').config();

const express = require('express');
const path = require('path');
const axios = require('axios');
const { getPortfolio, savePortfolio, searchCoinByName, getCoinDataById } = require('@sebastienrousseau/crypto-cli');
const { initCacheManager, getCachedPortfolio, updatePortfolioCache, fetchCoinPrice } = require('../../../cacheManager');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize the cache manager and start the server after initial cache is loaded
(async () => {
  await initCacheManager();
  app.get('/api/search', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Query is required.' });
  }

  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/search', {
      params: {
        query: query,
      },
    });

    res.json(response.data.coins);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/coin/:coinId/price', async (req, res) => {
  const { coinId } = req.params;
  try {
    const portfolio = await getCachedPortfolio();
    const coin = portfolio.find(item => item.coin === coinId);
    if (coin && coin.lastPrice && coin.lastPrice.usd !== 'N/A') {
      res.json({ price: coin.lastPrice.usd, value: (coin.amount * coin.lastPrice.usd).toFixed(2) });
    } else {
      res.status(404).json({ error: 'Price not available yet.' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
})();

// API endpoint to get portfolio
app.get('/api/portfolio', async (req, res) => {
  try {
    const portfolio = await getCachedPortfolio(); // Get data from cache manager
    const portfolioWithPrices = [];
    let totalValue = 0;

    // Prepare initial response with cached data or live data if available
    for (const item of portfolio) {
      const cachedPrice = item.lastPrice && item.lastPrice.usd;

      let displayPrice = 'N/A';
      let displayValue = 'N/A';
      let displayName = item.name || item.coin;
      let displaySymbol = item.symbol || 'N/A';
      let isCached = false;

      if (cachedPrice) {
        displayPrice = cachedPrice >= 1 ? cachedPrice.toFixed(2) : (cachedPrice >= 0.0001 ? cachedPrice.toFixed(4) : cachedPrice.toFixed(8));
        displayValue = (item.amount * cachedPrice).toFixed(2);
        displayName = item.name;
        displaySymbol = item.symbol.toUpperCase();
        isCached = true;
      }

      if (displayValue !== 'N/A') {
        totalValue += parseFloat(displayValue);
      }

      portfolioWithPrices.push({
        name: displayName,
        symbol: displaySymbol,
        amount: item.amount,
        price: displayPrice,
        value: displayValue,
        cached: isCached,
        coin: item.coin, // Include the coin ID
      });
    }

    res.json({ portfolio: portfolioWithPrices, totalValue: totalValue.toFixed(2) });

    // Asynchronously fetch live prices and update portfolio.json
    (async () => {
      const latestPortfolio = await getPortfolio(); // Get the latest portfolio data
      const updatedPortfolio = [];

      // Fetch live prices for all coins in a single request for the background update
      let backgroundLiveCoinData = {};
      try {
        const backgroundCoinIds = latestPortfolio.map(item => item.coin);
        if (backgroundCoinIds.length > 0) {
          const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
            params: {
              vs_currency: 'usd',
              ids: backgroundCoinIds.join(','),
              sparkline: false,
              price_change_percentage: '1h,24h,7d',
            },
          });
          response.data.forEach(coin => {
            backgroundLiveCoinData[coin.id] = coin;
          });
        }
      } catch (error) {
        console.error('Error fetching live data for all coins in background update:', error.message);
      }

      for (const item of latestPortfolio) {
        // Check if the item needs a price update (no recent cache)
        const needsUpdate = !item.lastPrice || !item.lastPrice.usd || (Date.now() - item.lastPrice.timestamp >= 300000); // Cache older than 5 minutes

        if (needsUpdate) {
          await sleep(3000); // Introduce a delay to avoid API rate limits
          try {
            const coinData = backgroundLiveCoinData[item.coin]; // Use backgroundLiveCoinData
            if (coinData && coinData.current_price && typeof coinData.current_price.usd === 'number' && !isNaN(coinData.current_price.usd)) {
              const currentPrice = coinData.current_price.usd;
              // Update the item with the last fetched price and timestamp
              item.lastPrice = {
                usd: currentPrice,
                timestamp: Date.now(),
              };
              item.name = coinData.name;
              item.symbol = coinData.symbol;
            }
          } catch (error) {
            console.error(`Error fetching data for ${item.coin} in background:`, error.message);
          }
        }
        updatedPortfolio.push(item);
      }
      console.log('Before background savePortfolio:', updatedPortfolio);
      await savePortfolio(updatedPortfolio);
      console.log('After background savePortfolio.');
      console.log('Portfolio cache updated in background.');
    })();

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/portfolio/add', async (req, res) => {
  const { coinId, amount } = req.body;

  if (!coinId || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid coin ID or amount.' });
  }

  try {
    const portfolio = await getPortfolio();
    const existingCoin = portfolio.find(item => item.coin === coinId);

    if (existingCoin) {
      existingCoin.amount += parseFloat(amount);
    } else {
      portfolio.push({ coin: coinId, amount: parseFloat(amount), name: coinId, symbol: '?', lastPrice: { usd: 'N/A', timestamp: 0 } });
    }

    await savePortfolio(portfolio);
    updatePortfolioCache(portfolio); // Update the cache

    fetchCoinPrice(coinId); // Fetch price in the background

    res.status(200).json({ message: `Coin '${coinId}' added to portfolio.`, portfolio: portfolio });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to remove coin from portfolio
app.delete('/api/portfolio/remove/:coinId', async (req, res) => {
  const coinIdToRemove = req.params.coinId;
  try {
    let portfolio = await getPortfolio();
    const initialLength = portfolio.length;
    portfolio = portfolio.filter(item => item.coin !== coinIdToRemove);

    if (portfolio.length < initialLength) {
      await savePortfolio(portfolio);
      updatePortfolioCache(portfolio); // Update the cache
      res.status(200).json({ message: `Coin '${coinIdToRemove}' removed from portfolio.` });
    } else {
      res.status(404).json({ error: `Coin '${coinIdToRemove}' not found in portfolio.` });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


