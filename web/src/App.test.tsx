import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';

afterEach(() => {
  cleanup();
});

describe('App', () => {
  it('renders the app name heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'usage-metering' })).toBeDefined();
  });
});
