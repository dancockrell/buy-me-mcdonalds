export const reference = Object.freeze({
  id: "us-fast-food-2026-09-04",
  market: "United States",
  retrievedOn: "2026-09-04",
  currency: "USD",
  disclosure: "Independent U.S. menu-price references retrieved September 4, 2026. Prices vary by restaurant and ordering channel and may exclude tax and fees. These comparisons are not a quote for your nearest restaurant. The exact contribution is shown before payment.",
  fry: Object.freeze({
    mediumFriesMean: 3.56,
    averageFryCount: 78,
    unroundedValue: 0.045641,
    displayedValue: 0.05,
    qualification: "Provisional estimate using a published U.S. medium-fries mean and a small independent 10-order measurement experiment."
  })
});

export const supportOptions = Object.freeze([
  Object.freeze({ id: "estimated_fry", label: "One French fry", cents: 5 }),
  Object.freeze({ id: "vanilla_cone", label: "Vanilla cone", cents: 231 }),
  Object.freeze({ id: "hamburger", label: "Hamburger", cents: 289 }),
  Object.freeze({ id: "hamburger_happy_meal", label: "Happy Meal", cents: 619 }),
  Object.freeze({ id: "quarter_pounder_cheese_meal", label: "Quarter Pounder with Cheese meal", cents: 1219, recommended: true })
]);

export function getOption(id) {
  return supportOptions.find((option) => option.id === id) ?? null;
}

export function money(cents) {
  return (cents / 100).toFixed(2);
}
