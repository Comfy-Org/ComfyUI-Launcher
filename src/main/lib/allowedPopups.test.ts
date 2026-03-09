import { describe, it, expect } from 'vitest'
import { POPUP_ALLOWED_PREFIXES, shouldOpenInPopup } from './allowedPopups'

describe('POPUP_ALLOWED_PREFIXES', () => {
  it('includes the Firebase auth domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://dreamboothy.firebaseapp.com/')
  })

  it('includes the checkout domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://checkout.comfy.org/')
  })
})

describe('shouldOpenInPopup', () => {
  it('returns true for Firebase auth URLs', () => {
    expect(shouldOpenInPopup('https://dreamboothy.firebaseapp.com/__/auth/handler')).toBe(true)
  })

  it('returns true for checkout URLs', () => {
    expect(shouldOpenInPopup('https://checkout.comfy.org/session/abc123')).toBe(true)
  })

  it('returns false for unknown URLs', () => {
    expect(shouldOpenInPopup('https://evil.example.com/')).toBe(false)
  })

  it('returns false for partial prefix matches', () => {
    expect(shouldOpenInPopup('https://dreamboothy.firebaseapp.com.evil.com/')).toBe(false)
  })
})
