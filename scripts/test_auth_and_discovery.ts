import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const baseUrl = 'http://127.0.0.1:3000';

async function runAuthAndDiscoveryTests() {
  console.log('===============================================================');
  console.log('   CRAVECART AUTHENTICATION & RESTAURANT DISCOVERY TEST SUITE');
  console.log('===============================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, testName: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}`);
      throw new Error(`Test assertion failed: ${testName}`);
    }
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // -------------------------------------------------------------
    // TASK 1: AUTHENTICATION & ACCESS CONTROL
    // -------------------------------------------------------------
    console.log('--- SECTION 1: AUTHENTICATION, PASSWORDS & TOKENS ---');

    // 1. Customer Registration
    const testEmail = `test_reg_${Date.now()}@example.com`;
    const testPassword = 'SecurePass@123';
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Customer',
        email: testEmail,
        password: testPassword,
        phone: '+91 99999 11111',
      }),
    });
    const regData = await regRes.json();
    assert(regRes.status === 201, 'Customer registration returns HTTP 201');
    assert(!!regData.token, 'Registration returns valid JWT session token');
    assert(regData.user && !regData.user.password && !regData.user.password_hash, 'Password and password_hash are NEVER returned in registration response');

    // Verify hash in Neon
    const dbHashRes = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', [testEmail]);
    assert(dbHashRes.rows.length === 1 && dbHashRes.rows[0].password_hash.startsWith('$2'), 'Password securely hashed with bcrypt in Neon PostgreSQL');

    // 2. Customer Login with registered credentials
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    const loginData = await loginRes.json();
    assert(loginRes.status === 200, 'Customer login succeeds with HTTP 200');
    assert(loginData.user.email === testEmail, 'Login returns correct authenticated user payload');
    assert(!loginData.user.password_hash, 'Password hash is NOT exposed in login response');

    // 3. Admin Login & Authorization
    const adminLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@cravecart.com', password: 'Admin@123' }),
    });
    const adminData = await adminLoginRes.json();
    assert(adminLoginRes.status === 200 && adminData.user.role === 'admin', 'Admin login succeeds with role = "admin"');

    // Admin can access admin routes
    const adminOverviewRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${adminData.token}` },
    });
    assert(adminOverviewRes.status === 200, 'Admin can access /api/admin/overview');

    // Customer CANNOT access admin routes
    const customerAdminAttempt = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    assert(customerAdminAttempt.status === 403, 'Customer is blocked from /api/admin/overview with HTTP 403 Forbidden');

    // 4. Delivery Partner Login & Authorization
    const agentLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'vikram@cravecart.com', password: 'Agent@123' }),
    });
    const agentData = await agentLoginRes.json();
    assert(agentLoginRes.status === 200 && agentData.user.role === 'delivery_agent', 'Delivery partner login succeeds with role = "delivery_agent"');

    // Delivery agent can access delivery routes
    const deliveryTasksRes = await fetch(`${baseUrl}/api/delivery/tasks`, {
      headers: { Authorization: `Bearer ${agentData.token}` },
    });
    assert(deliveryTasksRes.status === 200, 'Delivery agent can access /api/delivery/tasks');

    // Customer CANNOT access delivery fleet routes
    const customerDeliveryAttempt = await fetch(`${baseUrl}/api/delivery/tasks`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    assert(customerDeliveryAttempt.status === 403, 'Customer is blocked from /api/delivery/tasks with HTTP 403 Forbidden');

    // 5. Existing Customer Logins (Aarav & Divya)
    const aaravRes = await (await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'aarav@example.com', password: 'Customer@123' }),
    })).json();
    assert(aaravRes.user && aaravRes.user.name === 'Aarav Sharma', 'Existing customer Aarav Sharma logs in successfully with preserved password');

    const divyaRes = await (await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'divya@cravecart.com', password: 'Divya@123' }),
    })).json();
    assert(divyaRes.user && divyaRes.user.name === 'Divya Sundaram', 'Existing customer Divya Sundaram logs in successfully with preserved password');

    // 6. JWT Page Refresh (/api/auth/me)
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    const meData = await meRes.json();
    assert(meRes.status === 200 && meData.user.id === loginData.user.id, 'Session restores correctly via /api/auth/me after page refresh');
    assert(!meData.user.password_hash, '/api/auth/me does not expose password_hash');

    // 7. Isolation: Customer Cart, Orders and Saved Addresses
    console.log('\n--- SECTION 2: CUSTOMER DATA ISOLATION ---');
    // Test user adds an item to cart
    await fetch(`${baseUrl}/api/cart/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
      body: JSON.stringify({ menuItemId: 1, quantity: 2 }),
    });

    // Aarav reads his cart
    const aaravCartRes = await (await fetch(`${baseUrl}/api/cart`, {
      headers: { Authorization: `Bearer ${aaravRes.token}` },
    })).json();

    // Verify Aarav's cart does not have test user's cart item ID
    const testUserCartRes = await (await fetch(`${baseUrl}/api/cart`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    })).json();
    assert(testUserCartRes.items.length > 0 && testUserCartRes.cartId !== aaravCartRes.cartId, 'Cart is strictly isolated per authenticated user');

    // Test user tries to access Aarav's orders
    // Find one of Aarav's order IDs in database
    const aaravOrder = await pool.query<{ id: number }>('SELECT id FROM orders WHERE customer_id = 1 LIMIT 1');
    if (aaravOrder.rows.length > 0) {
      const crossOrderRes = await fetch(`${baseUrl}/api/orders/${aaravOrder.rows[0].id}`, {
        headers: { Authorization: `Bearer ${loginData.token}` },
      });
      assert(crossOrderRes.status === 403, 'Cross-customer order access is blocked with HTTP 403 Forbidden');
    }

    // Test user reads saved addresses: must be empty for new user
    const userAddresses = await (await fetch(`${baseUrl}/api/profile/addresses`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    })).json();
    assert(Array.isArray(userAddresses.addresses) && userAddresses.addresses.length === 0, 'Saved addresses are strictly isolated to authenticated user');

    // Clean up test user
    await pool.query('DELETE FROM carts WHERE user_id = $1', [loginData.user.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [loginData.user.id]);

    // -------------------------------------------------------------
    // TASK 3: RESTAURANT DISCOVERY & POSTGRESQL DATA
    // -------------------------------------------------------------
    console.log('\n--- SECTION 3: RESTAURANT DISCOVERY, SEARCH & FILTERS ---');

    // 1. Total Restaurants and Menu Items in Neon
    const restCountRes = await pool.query<{ count: string }>('SELECT count(*) FROM restaurants WHERE is_active = true');
    const dbRestCount = parseInt(restCountRes.rows[0].count, 10);
    assert(dbRestCount === 32, `Exactly 32 restaurants in Neon (got ${dbRestCount})`);

    const menuCountRes = await pool.query<{ count: string }>('SELECT count(*) FROM menu_items');
    const dbMenuCount = parseInt(menuCountRes.rows[0].count, 10);
    assert(dbMenuCount === 128, `Exactly 128 menu items in Neon (got ${dbMenuCount})`);

    // Verify API returns 32 restaurants
    const allRestApi = await (await fetch(`${baseUrl}/api/restaurants`)).json();
    assert(allRestApi.restaurants.length === 32, `API returns all 32 restaurants from Neon (got ${allRestApi.restaurants.length})`);

    // 2. Restaurant Detail and Menu Items
    const detailRes = await (await fetch(`${baseUrl}/api/restaurants/1`)).json();
    assert(detailRes.restaurant && detailRes.restaurant.name === 'Biryani Darbar', 'Restaurant detail endpoint returns correct data for Biryani Darbar');

    const menuRes = await (await fetch(`${baseUrl}/api/restaurants/1/menu`)).json();
    assert(menuRes.items && menuRes.items.length === 7, `Biryani Darbar menu contains its 7 dishes from Neon (got ${menuRes.items?.length})`);

    // 3. Search Filter
    const searchRes = await (await fetch(`${baseUrl}/api/restaurants?search=Pizzeria`)).json();
    assert(searchRes.restaurants.length === 1 && searchRes.restaurants[0].name.includes('Pizzeria'), 'Search filter works for "Pizzeria"');

    const dishSearchRes = await (await fetch(`${baseUrl}/api/restaurants?search=Dumplings`)).json();
    assert(dishSearchRes.restaurants.some((r: any) => r.name.includes('Wok')), 'Search filter finds restaurant by available dish name ("Dumplings")');

    // 4. Category Filter matching available menu items
    const biryaniCategoryRes = await (await fetch(`${baseUrl}/api/restaurants?category=Biryani`)).json();
    assert(biryaniCategoryRes.restaurants.length === 2, `Category "Biryani" returns only restaurants with available Biryani dishes (got ${biryaniCategoryRes.restaurants.length})`);
    const biryaniNames = biryaniCategoryRes.restaurants.map((r: any) => r.name);
    assert(biryaniNames.includes('Biryani Darbar') && biryaniNames.includes('Hyderabad Nawabi Biryani'), 'Both Biryani specialty restaurants included');
    assert(!biryaniNames.includes('The Coastal Spice Catch'), 'Restaurant with NO Biryani menu items ("The Coastal Spice Catch") is correctly excluded');

    // 5. Rating Filter (4.0+)
    const ratingRes = await (await fetch(`${baseUrl}/api/restaurants?minRating=4.0`)).json();
    const allAbove4 = ratingRes.restaurants.every((r: any) => parseFloat(r.avg_rating) >= 4.0);
    assert(allAbove4 && ratingRes.restaurants.length > 0, `Rating filter (4.0+) returns only restaurants >= 4.0 (found ${ratingRes.restaurants.length})`);

    // 6. Vegetarian Filter
    const vegRes = await (await fetch(`${baseUrl}/api/restaurants?pureVeg=true`)).json();
    const allVeg = vegRes.restaurants.every((r: any) => r.is_pure_veg === true);
    assert(allVeg && vegRes.restaurants.length === 15, `Pure veg filter returns all 15 pure veg restaurants (got ${vegRes.restaurants.length})`);

    // 7. Price Bracket Filter
    const lowPriceRes = await (await fetch(`${baseUrl}/api/restaurants?priceBracket=low`)).json();
    const allLow = lowPriceRes.restaurants.every((r: any) => parseFloat(r.price_for_two) < 400);
    assert(allLow && lowPriceRes.restaurants.length === 10, `Price bracket "low" (< 400) returns 10 restaurants (got ${lowPriceRes.restaurants.length})`);

    const highPriceRes = await (await fetch(`${baseUrl}/api/restaurants?priceBracket=high`)).json();
    const allHigh = highPriceRes.restaurants.every((r: any) => parseFloat(r.price_for_two) > 600);
    assert(allHigh && highPriceRes.restaurants.length === 9, `Price bracket "high" (> 600) returns 9 restaurants (got ${highPriceRes.restaurants.length})`);

    // 8. Multiple Filters Working Together
    const multiFilterRes = await (await fetch(`${baseUrl}/api/restaurants?pureVeg=true&priceBracket=low&minRating=4.0`)).json();
    const multiValid = multiFilterRes.restaurants.every(
      (r: any) => r.is_pure_veg === true && parseFloat(r.price_for_two) < 400 && parseFloat(r.avg_rating) >= 4.0
    );
    assert(multiValid && multiFilterRes.restaurants.length > 0, `Combined filters (Pure Veg + Low Price + Rating 4.0+) work together (found ${multiFilterRes.restaurants.length})`);

    // 9. Sorting genuinely changes order
    const sortPriceAsc = await (await fetch(`${baseUrl}/api/restaurants?sortBy=price_asc`)).json();
    const sortPriceDesc = await (await fetch(`${baseUrl}/api/restaurants?sortBy=price_desc`)).json();
    const sortPopular = await (await fetch(`${baseUrl}/api/restaurants?sortBy=popular`)).json();

    const firstPriceAsc = sortPriceAsc.restaurants[0];
    const firstPriceDesc = sortPriceDesc.restaurants[0];
    const firstPopular = sortPopular.restaurants[0];

    assert(parseFloat(firstPriceAsc.price_for_two) <= parseFloat(sortPriceAsc.restaurants[1].price_for_two), 'price_asc genuinely sorts by ascending price');
    assert(parseFloat(firstPriceDesc.price_for_two) >= parseFloat(sortPriceDesc.restaurants[1].price_for_two), 'price_desc genuinely sorts by descending price');
    assert(firstPriceAsc.id !== firstPriceDesc.id, 'price_asc and price_desc produce different leading results');
    assert(firstPopular.name === 'Biryani Darbar', 'popular sort ranks most-ordered restaurant ("Biryani Darbar") first');

    console.log('\n===============================================================');
    console.log(`   ALL ${passed} / ${total} AUTHENTICATION & DISCOVERY TESTS PASSED!`);
    console.log('===============================================================\n');
  } finally {
    await pool.end();
  }
}

runAuthAndDiscoveryTests().catch((err) => {
  console.error('\n❌ Test Suite Failure:', err.message);
  process.exit(1);
});
