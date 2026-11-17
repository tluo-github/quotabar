// Generates Resources/AppIcon.icns (and docs/icon.png for the README).
// Usage: swift scripts/make-icon.swift
//
// Design: graphite rounded square with a speedometer-style gauge, the same shape as the menu bar
// icon: an open 270° dial, dots along it (used part in coral), a tapered coral needle and a hub.

import AppKit
import Foundation

let fill: CGFloat = 0.64     // how far the needle points

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha)
}

func draw(size px: Int) -> Data {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                        space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let s = CGFloat(px) / 1024
    ctx.scaleBy(x: s, y: s)

    // Body: Apple's macOS grid puts an 824pt rounded square inside the 1024 canvas.
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let bodyPath = CGPath(roundedRect: body, cornerWidth: 186, cornerHeight: 186, transform: nil)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: color(0x000000, 0.28))
    ctx.addPath(bodyPath)
    ctx.setFillColor(color(0x1E1E20))
    ctx.fillPath()
    ctx.restoreGState()

    // Subtle vertical gradient on the body.
    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()
    let bg = CGGradient(colorsSpace: space, colors: [color(0x323235), color(0x18181A)] as CFArray,
                        locations: [0, 1])!
    ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    // Thin inner highlight along the top edge.
    ctx.addPath(CGPath(roundedRect: body.insetBy(dx: 2, dy: 2), cornerWidth: 184, cornerHeight: 184, transform: nil))
    ctx.setStrokeColor(color(0xFFFFFF, 0.07))
    ctx.setLineWidth(4)
    ctx.strokePath()
    ctx.restoreGState()

    // Gauge: open 270° dial (gap at the bottom, so it reads as a gauge rather than a clock)
    let c = CGPoint(x: 512, y: 480)
    func rad(_ d: CGFloat) -> CGFloat { d * .pi / 180 }
    let start: CGFloat = 225, sweep: CGFloat = 270

    ctx.setLineCap(.round)
    ctx.setLineWidth(34)
    ctx.setStrokeColor(color(0xFFFFFF, 0.92))
    ctx.addArc(center: c, radius: 300, startAngle: rad(start), endAngle: rad(start - sweep), clockwise: true)
    ctx.strokePath()

    // Dots along the dial: coral up to the needle, dim after it
    let n = 7
    for i in 0..<n {
        let t = CGFloat(i) / CGFloat(n - 1)
        let a = rad(start - sweep * t)
        let p = CGPoint(x: c.x + cos(a) * 205, y: c.y + sin(a) * 205)
        ctx.setFillColor(t <= fill + 0.001 ? color(0xF0936F) : color(0xFFFFFF, 0.28))
        ctx.fillEllipse(in: CGRect(x: p.x - 22, y: p.y - 22, width: 44, height: 44))
    }

    // Tapered needle
    let na = rad(start - sweep * fill)
    let tip = CGPoint(x: c.x + cos(na) * 195, y: c.y + sin(na) * 195)
    let perp = na + .pi / 2
    ctx.setFillColor(color(0xE8825E))
    ctx.move(to: CGPoint(x: c.x + cos(perp) * 30, y: c.y + sin(perp) * 30))
    ctx.addLine(to: tip)
    ctx.addLine(to: CGPoint(x: c.x - cos(perp) * 30, y: c.y - sin(perp) * 30))
    ctx.closePath()
    ctx.fillPath()

    // Hub
    ctx.setFillColor(color(0xFFFFFF))
    ctx.fillEllipse(in: CGRect(x: c.x - 44, y: c.y - 44, width: 88, height: 88))
    ctx.setFillColor(color(0x1E1E20))
    ctx.fillEllipse(in: CGRect(x: c.x - 14, y: c.y - 14, width: 28, height: 28))

    let image = ctx.makeImage()!
    return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!
}

let root = URL(fileURLWithPath: CommandLine.arguments.first.map { ($0 as NSString).deletingLastPathComponent } ?? ".")
    .deletingLastPathComponent()
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

for base in [16, 32, 128, 256, 512] {
    try draw(size: base).write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
    try draw(size: base * 2).write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
try draw(size: 256).write(to: root.appendingPathComponent("docs/icon.png"))   // README 用，小尺寸即可

let out = root.appendingPathComponent("Resources/AppIcon.icns")
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", out.path]
try p.run()
p.waitUntilExit()
print(p.terminationStatus == 0 ? "Wrote \(out.path)" : "iconutil failed")
