var test = require('node:test');
var assert = require('node:assert/strict');
var invoice = require('../lib/invoice');
var pricing = require('../lib/pricing');
var coupons = require('../lib/coupons');
var reports = require('../lib/reports');

function item(overrides) {
  return Object.assign({
    id: 1,
    sku: 'TEST-001',
    name: 'Test item',
    hsn: '0902',
    price: 100,
    qty: 1
  }, overrides);
}

// Builds an order-shaped fixture from pricing without exercising HTTP or storage.
function billedOrder(items, coupon) {
  var totals = pricing.computeTotals(items, coupon);
  return {
    id: 42,
    date: '01/04/2026',
    customer: 'Test customer',
    paymentMode: 'cash',
    status: 'completed',
    items: items,
    coupon: coupon || '',
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  };
}

test('invoice matches the billed total and GST breakdown for a discounted 5% item', function () {
  var order = {
    id: 42,
    date: '01/04/2026',
    customer: 'Test customer',
    paymentMode: 'cash',
    status: 'completed',
    items: [item({ hsn: '1006', price: 640 })],
    coupon: 'SAVE10',
    subtotal: 640,
    discount: 64,
    tax: 28.8,
    total: 604.8
  };

  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 640,
    discount: 64,
    tax: 28.8,
    cgst: 14.4,
    sgst: 14.4,
    total: 604.8,
    rows: [{
      name: 'Test item', sku: 'TEST-001', hsn: '1006', qty: 1,
      price: 640, gstPercent: 5, line: 640, lineTax: 28.8
    }]
  });
  var html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹28\.80<\/td>/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹604\.80<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice HTML displays the billed HSN rate, GST, and total without a mismatch warning', function () {
  var order = billedOrder([item({ hsn: '1006' })]);
  var html = invoice.render(order);

  assert.equal(order.tax, 5);
  assert.equal(order.total, 105);
  assert.match(html, /<td>1006<\/td>[\s\S]*?<td[^>]*>5%<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹5\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹105\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('checkout allocates a percentage discount before calculating mixed HSN taxes', function () {
  var items = [
    item({ name: 'Rice', hsn: '1006', price: 300 }),
    item({ id: 2, name: 'Ghee', hsn: '0405', price: 200 }),
    item({ id: 3, name: 'Tea', price: 500 })
  ];

  assert.deepEqual(pricing.computeTotals(items, 'SAVE10'), {
    subtotal: 1000,
    discount: 100,
    taxable: 900,
    tax: 116.1,
    cgst: 58.05,
    sgst: 58.05,
    total: 1016.1,
    lines: [
      { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 300, discount: 30, taxable: 270, tax: 13.5, net: 283.5 },
      { id: 2, name: 'Ghee', hsn: '0405', gstPercent: 12, gross: 200, discount: 20, taxable: 180, tax: 21.6, net: 201.6 },
      { id: 3, name: 'Tea', hsn: '0902', gstPercent: 18, gross: 500, discount: 50, taxable: 450, tax: 81, net: 531 }
    ]
  });
});

test('invoice preserves the billed 5%, 12%, and 18% HSN breakdown', function () {
  var order = billedOrder([
    item({ name: 'Rice', hsn: '1006', qty: 2 }),
    item({ id: 2, sku: 'TEST-002', name: 'Ghee', hsn: '0405' }),
    item({ id: 3, sku: 'TEST-003', name: 'Tea' })
  ]);

  assert.equal(order.subtotal, 400);
  assert.equal(order.tax, 40);
  assert.equal(order.total, 440);
  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 400,
    discount: 0,
    tax: 40,
    cgst: 20,
    sgst: 20,
    total: 440,
    rows: [
      { name: 'Rice', sku: 'TEST-001', hsn: '1006', qty: 2, price: 100, gstPercent: 5, line: 200, lineTax: 10 },
      { name: 'Ghee', sku: 'TEST-002', hsn: '0405', qty: 1, price: 100, gstPercent: 12, line: 100, lineTax: 12 },
      { name: 'Tea', sku: 'TEST-003', hsn: '0902', qty: 1, price: 100, gstPercent: 18, line: 100, lineTax: 18 }
    ]
  });
});

[
  { description: 'an 18% HSN', hsn: '0902' },
  { description: 'an unknown HSN using the fallback rate', hsn: '9999' }
].forEach(function (scenario) {
  test('invoice and checkout agree for ' + scenario.description + ' without a coupon', function () {
    var order = billedOrder([item({ hsn: scenario.hsn })]);
    var figures = invoice.computeInvoiceFigures(order);

    assert.equal(order.tax, 18);
    assert.equal(order.total, 118);
    assert.equal(figures.discount, 0);
    assert.equal(figures.tax, 18);
    assert.equal(figures.cgst, 9);
    assert.equal(figures.sgst, 9);
    assert.equal(figures.total, 118);
    assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
  });
});

test('percentage coupon invoice matches the billed discount, GST, and total', function () {
  var order = billedOrder([item({ price: 1000 })], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);
  var html = invoice.render(order);

  assert.equal(order.discount, 100);
  assert.equal(order.tax, 162);
  assert.equal(order.total, 1062);
  assert.equal(figures.discount, 100);
  assert.equal(figures.tax, 162);
  assert.equal(figures.cgst, 81);
  assert.equal(figures.sgst, 81);
  assert.equal(figures.total, 1062);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td[^>]*>-₹100\.00<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹162\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹1062\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice retains the capped percentage discount charged at checkout', function () {
  var order = billedOrder([item({ price: 2000 })], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.discount, 150);
  assert.equal(order.tax, 333);
  assert.equal(order.total, 2183);
  assert.equal(figures.discount, 150);
  assert.equal(figures.tax, 333);
  assert.equal(figures.cgst, 166.5);
  assert.equal(figures.sgst, 166.5);
  assert.equal(figures.total, 2183);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('flat coupon invoice calculates GST after the billed discount', function () {
  var order = billedOrder([item({ price: 400 })], 'FLAT50');
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.discount, 50);
  assert.equal(order.tax, 63);
  assert.equal(order.total, 413);
  assert.equal(figures.discount, 50);
  assert.equal(figures.tax, 63);
  assert.equal(figures.cgst, 31.5);
  assert.equal(figures.sgst, 31.5);
  assert.equal(figures.total, 413);
});

test('pricing and invoice honor an explicit whole-number percentage on a historical line item', function () {
  var order = billedOrder([item({ gstRate: 5 })]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 5);
  assert.equal(order.total, 105);
  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.rows[0].lineTax, 5);
  assert.equal(figures.tax, 5);
  assert.equal(figures.cgst, 2.5);
  assert.equal(figures.sgst, 2.5);
  assert.equal(figures.total, 105);
});

test('invoice interprets a decimal GST rate consistently with pricing', function () {
  var order = billedOrder([item({ gstRate: 0.05 })]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 5);
  assert.equal(order.total, 105);
  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.rows[0].lineTax, 5);
  assert.equal(figures.tax, 5);
  assert.equal(figures.cgst, 2.5);
  assert.equal(figures.sgst, 2.5);
  assert.equal(figures.total, 105);
});

test('invoice preserves an explicit zero GST rate', function () {
  var order = billedOrder([item({ gstRate: 0 })]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 0);
  assert.equal(order.total, 100);
  assert.equal(figures.rows[0].gstPercent, 0);
  assert.equal(figures.tax, 0);
  assert.equal(figures.cgst, 0);
  assert.equal(figures.sgst, 0);
  assert.equal(figures.total, 100);
});

test('invoice does not add an inactive coupon discount absent from the historical bill', function () {
  var order = billedOrder([item({ price: 1000 })]);
  order.coupon = 'DIWALI20';
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(coupons.validate(order.coupon, order.subtotal).valid, false);
  assert.equal(order.discount, 0);
  assert.equal(order.total, 1180);
  assert.equal(figures.discount, 0);
  assert.equal(figures.tax, 180);
  assert.equal(figures.total, 1180);
});

test('invoice does not add a percentage discount rejected by checkout minimum rules', function () {
  var order = billedOrder([item()]);
  order.coupon = 'SAVE10';
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(coupons.validate(order.coupon, order.subtotal).valid, false);
  assert.equal(order.discount, 0);
  assert.equal(order.total, 118);
  assert.equal(figures.discount, 0);
  assert.equal(figures.tax, 18);
  assert.equal(figures.total, 118);
});

test('invoice does not invent a flat discount or negative total for a small historical bill', function () {
  var order = billedOrder([item({ price: 25 })]);
  order.coupon = 'FLAT50';
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(coupons.validate(order.coupon, order.subtotal).valid, false);
  assert.equal(order.discount, 0);
  assert.equal(order.total, 29.5);
  assert.equal(figures.subtotal, 25);
  assert.equal(figures.discount, 0);
  assert.equal(figures.tax, 4.5);
  assert.equal(figures.total, 29.5);
});

test('invoice preserves the recorded discount when current coupon rules differ from the historical bill', function () {
  var order = billedOrder([item({ price: 1000 })], 'SAVE10');
  order.discount = 200;
  order.tax = 144;
  order.total = 944;
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.discount, 200);
  assert.equal(figures.tax, 144);
  assert.equal(figures.total, 944);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
  assert.equal(order.discount, 200);
  assert.equal(order.tax, 144);
  assert.equal(order.total, 944);
});

test('invoice preserves a recorded zero discount even when the coupon is now eligible', function () {
  var order = billedOrder([item({ price: 1000 })]);
  order.coupon = 'SAVE10';
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(coupons.validate(order.coupon, order.subtotal).discount, 100);
  assert.equal(figures.discount, 0);
  assert.equal(figures.tax, 180);
  assert.equal(figures.total, 1180);
});

test('invoice retains a recorded discount after its coupon has expired', function () {
  var order = billedOrder([item({ price: 1000 })]);
  order.coupon = 'DIWALI20';
  order.discount = 200;
  order.tax = 144;
  order.total = 944;
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(coupons.validate(order.coupon, order.subtotal).valid, false);
  assert.equal(figures.discount, 200);
  assert.equal(figures.tax, 144);
  assert.equal(figures.total, 944);
});

test('invoice falls back to coupon rules when a legacy order has no recorded discount', function () {
  var order = billedOrder([item({ price: 2000 })], 'SAVE10');
  delete order.discount;
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.discount, 150);
  assert.equal(figures.tax, 333);
  assert.equal(figures.total, 2183);
});

test('invoice row GST and CGST/SGST use the same rounding as the billed total', function () {
  var order = billedOrder([
    item({ price: 0.03 }),
    item({ id: 2, price: 0.03 }),
    item({ id: 3, price: 0.03 })
  ]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.subtotal, 0.09);
  assert.equal(order.tax, 0.03);
  assert.equal(order.total, 0.12);
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01, 0.01]);
  assert.equal(figures.tax, 0.03);
  assert.equal(figures.cgst, 0.02);
  assert.equal(figures.sgst, 0.01);
  assert.equal(figures.total, 0.12);
});

test('reconciliation matches both GST and total after a percentage discount', function () {
  var order = billedOrder([item({ price: 1000 })], 'SAVE10');

  assert.deepEqual(reports.getGstReconciliation({ orders: [order] }), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 42,
      date: '01/04/2026',
      customer: 'Test customer',
      coupon: 'SAVE10',
      ledgerSubtotal: 1000,
      ledgerDiscount: 100,
      ledgerTax: 162,
      ledgerTotal: 1062,
      invoiceDiscount: 100,
      invoiceTax: 162,
      invoiceTotal: 1062,
      delta: 0,
      matched: true
    }]
  });
});
