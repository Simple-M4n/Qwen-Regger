// Unit tests for Qwen OTP extraction and response classification.
// Run: node --test test/otp.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOtpCode } from '../lib/mail.js';
import {
  extractToken,
  isWafHtml,
  requestSucceeded,
  verifySucceeded,
  classifyFailure,
} from '../lib/qwen.js';

test('extracts a plain verification code', () => {
  assert.equal(extractOtpCode('Your Qwen verification code is 123456.'), '123456');
});

test('extracts the code from HTML email', () => {
  const html = '<html><body><p>Your verification code is <b>987654</b></p><p>Qwen</p></body></html>';
  assert.equal(extractOtpCode(html), '987654');
});

test('prefers the code near verification wording', () => {
  const text = 'Order 123456 was placed. Your verification code is 654321. Thanks!';
  assert.equal(extractOtpCode(text), '654321');
});

test('handles escaped email entities', () => {
  assert.equal(extractOtpCode('Your code is&nbsp;654321 &amp; more'), '654321');
});

test('ignores unrelated six-digit numbers', () => {
  assert.equal(extractOtpCode('Your invoice number is 100200'), null);
});

test('extracts token from verify payload', () => {
  assert.equal(extractToken({ success: true, data: { access_token: 'abc.def.ghi' } }), 'abc.def.ghi');
  assert.equal(extractToken({ success: true, data: { user: { token: 'xyz' } } }), 'xyz');
  assert.equal(extractToken({ success: false, data: {} }), '');
});

test('detects Aliyun WAF HTML', () => {
  assert.equal(isWafHtml('<!doctype html><meta name="aliyun_waf_aa" content="x">'), true);
  assert.equal(isWafHtml('{"success":true}'), false);
});

test('request/verify success helpers', () => {
  assert.equal(requestSucceeded({ success: true, data: { status: 'sent' } }), true);
  assert.equal(requestSucceeded({ success: true, data: {} }), false);
  assert.equal(requestSucceeded({ success: false, data: { status: 'sent' } }), false);
  assert.equal(verifySucceeded({ success: true, data: { token: 'jwt' } }), true);
  assert.equal(verifySucceeded({ success: true, data: {} }), false);
});

test('classifies failure kinds', () => {
  assert.equal(classifyFailure({ status: 200, text: '<meta name="aliyun_waf_aa">' }).kind, 'waf_block');
  assert.equal(classifyFailure({ status: 429, data: { details: 'Too many requests' } }).kind, 'rate_limit');
  assert.equal(classifyFailure({ status: 200, data: { details: 'Email already registered' } }).kind, 'email_taken');
  assert.equal(classifyFailure({ status: 500, data: { message: 'boom' } }).kind, 'server');
});
