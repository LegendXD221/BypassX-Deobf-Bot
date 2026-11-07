/**
 * v1.5.1 regression tests — L3 confirm gate (owner-guard.confirmGate).
 *
 * The shipped v1.5.0 bug: the collect handler called collector.stop() BEFORE
 * done(yes). stop() emits 'end' synchronously and the end handler resolved the
 * gate with false — so pressing CONFIRM on a dangerous command always behaved
 * like Cancel ("when I click confirm it just cancels it").
 *
 * These tests simulate discord.js collector semantics exactly: stop() emits
 * 'end' synchronously with the stop reason.
 *
 * Run: node test/confirm-gate.js
 */
import assert from 'node:assert/strict';
import { confirmGate } from '../src/owner-guard.js';
import { CONFIG } from '../src/config.js';

const OWNER = CONFIG.ownerId;
const OTHER = '999000111222333444';

function fakeButtonInteraction(customId, userId) {
  return {
    customId,
    user: { id: userId },
    deferUpdate: async () => {},
    reply: async () => {},
  };
}

/** Mimic discord.js collectors: stop(reason) emits 'end' SYNCHRONOUSLY. */
function makeFakeCollector() {
  const c = {
    handlers: { collect: [], end: [] },
    stopped: false,
    stopReason: null,
    edits: [],
  };
  c.on = (ev, fn) => { (c.handlers[ev] || []).push(fn); return c; };
  c.emit = (ev, ...args) => { for (const fn of [...(c.handlers[ev] || [])]) fn(...args); };
  c.stop = (reason = 'user') => {
    if (c.stopped) return;
    c.stopped = true;
    c.stopReason = reason;
    c.emit('end', new Map(), reason); // ← synchronous, like the real library
  };
  return c;
}

function makeFakeCtx() {
  const collectorRef = { current: null };
  let sentCard = null;
  const msg = {
    edit: async (payload) => { collectorRef.current.edits.push(payload); },
    createMessageComponentCollector: () => {
      collectorRef.current = makeFakeCollector();
      return collectorRef.current;
    },
  };
  const ctx = {
    isSlash: false,
    reply: async (payload) => { sentCard = payload; return msg; },
  };
  return { ctx, collectorRef, getCard: () => sentCard };
}

/** Extract { confirmId, cancelId } from the posted card (Danger = confirm). */
function buttonIds(card) {
  assert.ok(card?.components?.length, 'the gate posts a card');
  const json = card.components.map((c) => c.toJSON());
  let confirmId = null;
  let cancelId = null;
  for (const comp of json) {
    for (const row of comp.components || []) {
      for (const b of row.components || []) {
        if (b.style === 4) confirmId = b.custom_id; // ButtonStyle.Danger
        if (b.style === 2) cancelId = b.custom_id;  // ButtonStyle.Secondary
      }
    }
  }
  assert.ok(confirmId && cancelId, 'confirm card carries both buttons');
  return { confirmId, cancelId };
}

const settle = () => new Promise((r) => setImmediate(r));

// ---- 1. OWNER presses CONFIRM → gate resolves TRUE (the regression) ----------
{
  const { ctx, collectorRef, getCard } = makeFakeCtx();
  const p = confirmGate(ctx, { title: 'Confirm test', details: 'regression' });
  await settle();
  const col = collectorRef.current;
  assert.ok(col, 'gate attaches a collector to the posted card');
  const { confirmId } = buttonIds(getCard());

  col.emit('collect', fakeButtonInteraction(confirmId, OWNER));
  const verdict = await p;
  assert.equal(verdict, true, 'CONFIRM click must resolve TRUE (v1.5.0 bug: it resolved false)');
  assert.equal(col.stopReason, 'confirmed', 'collector stops with the confirmed reason');
  assert.ok(col.edits.length >= 1, 'post-resolution edit swaps the buttons out');
  console.log('confirm gate: CONFIRM resolves true — ok');
}

// ---- 2. OWNER presses CANCEL → gate resolves FALSE ----------------------------
{
  const { ctx, collectorRef, getCard } = makeFakeCtx();
  const p = confirmGate(ctx, { title: 'Confirm test', details: null });
  await settle();
  const col = collectorRef.current;
  const { cancelId } = buttonIds(getCard());

  col.emit('collect', fakeButtonInteraction(cancelId, OWNER));
  const verdict = await p;
  assert.equal(verdict, false, 'CANCEL click must resolve false');
  assert.equal(col.stopReason, 'cancelled', 'collector stops with the cancelled reason');
  console.log('confirm gate: CANCEL resolves false — ok');
}

// ---- 3. NON-OWNER click does NOT consume the gate ------------------------------
{
  const { ctx, collectorRef, getCard } = makeFakeCtx();
  const p = confirmGate(ctx, { title: 'Confirm test', details: null });
  await settle();
  const col = collectorRef.current;
  const { confirmId } = buttonIds(getCard());

  col.emit('collect', fakeButtonInteraction(confirmId, OTHER)); // stranger presses Confirm
  const strangerSettled = await Promise.race([p.then(() => true), settle().then(() => false)]);
  assert.equal(strangerSettled, false, 'a non-owner click must NOT settle the gate');
  assert.equal(col.stopped, false, 'collector still alive after a stranger click');

  col.emit('collect', fakeButtonInteraction(confirmId, OWNER)); // owner then confirms
  const verdict = await p;
  assert.equal(verdict, true, 'owner can still confirm after stranger clicks');
  console.log('confirm gate: stranger clicks ignored, owner still decides — ok');
}

// ---- 4. TIMEOUT (end with a non-confirmed reason) resolves FALSE ---------------
{
  const { ctx, collectorRef } = makeFakeCtx();
  const p = confirmGate(ctx, { title: 'Confirm test', details: null });
  await settle();
  const col = collectorRef.current;
  col.stop('time'); // discord.js ends collectors with reason 'time' on expiry
  const verdict = await p;
  assert.equal(verdict, false, 'timeout must resolve false');
  console.log('confirm gate: timeout resolves false — ok');
}

console.log('\nALL CONFIRM-GATE REGRESSION TESTS PASSED');
