/**
 * Cộng hai số.
 *
 * Success Criteria:
 * - add(a, b) trả về a + b.
 * - add(19, 23) trả về 42.
 */
function add(a, b) {
  return a + b;
}

if (require.main === module) {
  const result = add(19, 23);

  if (result !== 42) {
    throw new Error(`Expected 42, received ${result}`);
  }

  console.log(result);
}

module.exports = { add };
