'use strict';

const config = require('../config');
const HttpError = require('../domain/http-error');
const { requestJson } = require('./http-client');

async function resolveDishes(dishIds, requestId) {
  const result = await requestJson(config.menuBaseUrl, '/internal/v1/dishes/resolve', {
    method: 'POST', body: JSON.stringify({ dishIds }), requestId
  });
  const dishes = result.dishes || result.data?.dishes;
  if (!Array.isArray(dishes)) throw new HttpError(502, 'INVALID_MENU_RESPONSE', 'Menu service returned an invalid response');
  const byId = new Map(dishes.map((dish) => [String(dish.id), dish]));
  for (const id of dishIds) {
    const dish = byId.get(String(id));
    if (!dish || dish.status !== 'ACTIVE') throw new HttpError(422, 'DISH_UNAVAILABLE', 'One or more dishes are not available', { dishId: id });
    if (!Number.isSafeInteger(Number(dish.priceVnd)) || Number(dish.priceVnd) <= 0) {
      throw new HttpError(502, 'INVALID_MENU_RESPONSE', 'Menu service returned an invalid dish price', { dishId: id });
    }
  }
  return byId;
}

module.exports = { resolveDishes };
