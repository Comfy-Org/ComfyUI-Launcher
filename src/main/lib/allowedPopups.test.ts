import { describe, it, expect } from 'vitest'
import { POPUP_ALLOWED_PREFIXES, shouldOpenInPopup } from './allowedPopups'

describe('POPUP_ALLOWED_PREFIXES', () => {
  it('includes the Firebase auth domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://dreamboothy.firebaseapp.com/')
  })

  it('includes the checkout domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://checkout.comfy.org/')
  })

  it('includes the Google accounts domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://accounts.google.com/')
  })

  it('includes the GitHub OAuth domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://github.com/login/oauth/')
  })
})

describe('shouldOpenInPopup', () => {
  it('returns true for Firebase auth URLs', () => {
    expect(shouldOpenInPopup('https://dreamboothy.firebaseapp.com/__/auth/handler')).toBe(true)
  })

  it('returns true for checkout URLs', () => {
    expect(shouldOpenInPopup('https://checkout.comfy.org/session/abc123')).toBe(true)
  })

  it('returns true for Google accounts URLs', () => {
    expect(shouldOpenInPopup('https://accounts.google.com/o/oauth2/auth?client_id=abc')).toBe(true)
  })

  it('returns true for GitHub OAuth URLs', () => {
    expect(shouldOpenInPopup('https://github.com/login/oauth/authorize?client_id=abc')).toBe(true)
  })

  it('returns false for unknown URLs', () => {
    expect(shouldOpenInPopup('https://evil.example.com/')).toBe(false)
  })

  it('returns false for partial prefix matches', () => {
    expect(shouldOpenInPopup('https://dreamboothy.firebaseapp.com.evil.com/')).toBe(false)
  })
})
