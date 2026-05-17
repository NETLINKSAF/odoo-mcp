import { describe, it, expect } from 'vitest';
import { renderConsentPage, renderErrorPage } from '../src/consent-page.js';

describe('renderConsentPage', () => {
  it('returns HTML with form, email input, password input, and submit button', () => {
    const html = renderConsentPage({ formAction: '/oauth/authorize?foo=bar' });
    expect(html).toContain('<form');
    expect(html).toContain('<input type="email"');
    expect(html).toContain('<input type="password"');
    expect(html).toContain('<button');
  });

  it('XSS in client_name: escapes and does not emit raw <script>', () => {
    const html = renderConsentPage({
      formAction: '/x',
      client_name: '<script>alert(1)</script>',
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('XSS in error: escapes <img and does not emit raw <img', () => {
    const html = renderConsentPage({
      formAction: '/x',
      error: '<img src=x onerror=alert(1)>',
    });
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  it('XSS in email: value attribute is escaped', () => {
    const html = renderConsentPage({ formAction: '/x', email: 'foo"bar"' });
    expect(html).toContain('value="foo&quot;bar&quot;"');
  });

  it('formAction with & and " is escaped in action attribute', () => {
    const html = renderConsentPage({ formAction: 'http://a/?x=1&y="z"' });
    expect(html).toContain('action="http://a/?x=1&amp;y=&quot;z&quot;"');
    expect(html).not.toContain('action="http://a/?x=1&y=');
  });

  it('email is pre-filled when provided', () => {
    const html = renderConsentPage({ formAction: '/x', email: 'user@example.com' });
    expect(html).toContain('value="user@example.com"');
  });

  it('error element is absent when error is not provided', () => {
    const html = renderConsentPage({ formAction: '/x' });
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('class="error"');
  });

  it('uses client_name in title when provided', () => {
    const html = renderConsentPage({ formAction: '/x', client_name: 'My App' });
    expect(html).toContain('Authorize My App');
  });

  it('uses default title when client_name is absent', () => {
    const html = renderConsentPage({ formAction: '/x' });
    expect(html).toContain('Authorize MCP Client');
  });
});

describe('renderErrorPage', () => {
  it('escapes title and message, emits no raw tags', () => {
    const html = renderErrorPage({ title: '<x>', message: '<y>' });
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('&lt;y&gt;');
    expect(html).not.toContain('<x>');
    expect(html).not.toContain('<y>');
  });

  it('returns complete HTML document with h1 and p', () => {
    const html = renderErrorPage({ title: 'Error', message: 'Something went wrong' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<h1>Error</h1>');
    expect(html).toContain('<p>Something went wrong</p>');
  });
});
