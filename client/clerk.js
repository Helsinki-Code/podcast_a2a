import { Clerk } from '@clerk/clerk-js';

window.createSalesForgeClerk = async publishableKey => {
  const clerk = new Clerk(publishableKey);
  await clerk.load();
  return clerk;
};
