//
//  Settings.swift
//  Nice2Meechu iOS shell
//

import WebKit

struct Cookie {
    var name: String
    var value: String
}

let gcmMessageIDKey = "gcm.message_id"

let rootUrl = URL(string: "https://nice2meechu.com/")!

// rootUrl should be in allowedOrigins. allowedOrigins + authOrigins <= 10 domains max.
// All domains should be in WKAppBoundDomains list
let allowedOrigins = [ "nice2meechu.com" ]
let authOrigins = [ "appleid.apple.com", "accounts.google.com" ]

let platformCookie = Cookie(name: "app-platform", value: "ios/ipados")

// UI options
let displayMode = "standalone" // standalone / fullscreen.
let adaptiveUIStyle = true     // iOS 15+ only. Change app theme on the fly to dark/light related to WebView background color.
let overrideStatusBar = false  // iOS 13-14 only. if you don't support dark/light system theme.
let statusBarTheme = "dark"    // dark / light, related to override option.
let pullToRefresh = true       // Enable/disable pull down to refresh page
