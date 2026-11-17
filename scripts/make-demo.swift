// 合成演示视频帧：把 3 倍渲染的静态画面按时间线串起来，叠加系统光标和点击涟漪，
// 原始 RGBA 帧写到 stdout，交给 ffmpeg 编码。
// 由 scripts/make-demo.sh 调用：make-demo <画面目录> <深色偏好画面目录> <用量tab x> <会话tab x> <统计tab x> <深色按钮 x>
import AppKit

_ = NSApplication.shared
let a = CommandLine.arguments
let dir = a[1], darkDir = a[2]
let tabU = Double(a[3])!, tabS = Double(a[4])!, tabT = Double(a[5])!, darkX = Double(a[6])!
let S = 3.0                 // 像素 / 点
let W = 1260, H = 2010
let fps = 60.0

func load(_ p: String) -> CGImage {
    let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil)!
    return CGImageSourceCreateImageAtIndex(src, 0, nil)!
}
let closed = load("\(dir)/closed-light.png")
let usage = load("\(dir)/usage-light.png")
let sessions = load("\(dir)/sessions-light.png")
let stats = load("\(dir)/stats-light.png")
let settings = load("\(dir)/settings-light.png")
let settingsDark = load("\(darkDir)/settings-dark.png")
let usageDark = load("\(darkDir)/usage-dark.png")

// 画面切换：(时刻, 新画面, 淡入时长)
let scenes: [(Double, CGImage, Double)] = [
    (0, closed, 0),
    (1.45, usage, 0.22),
    (4.95, sessions, 0.12),
    (8.35, stats, 0.12),
    (11.65, settings, 0.15),
    (13.05, settingsDark, 0.35),
    (15.05, usageDark, 0.15),
    (17.3, closed, 0.45),
]
let total = 18.0

// 光标关键帧 (时刻, x, y)，点坐标，左上为原点；相邻两帧之间缓动移动
let start = (215.0, 330.0)
let keys: [(Double, Double, Double)] = [
    (0, start.0, start.1), (0.6, start.0, start.1),
    (1.3, 337, 15),                         // 状态栏
    (1.8, 337, 15), (2.5, 250, 300),
    (4.2, 255, 305), (4.8, tabS, 95),        // 会话
    (5.2, tabS, 95), (5.9, 240, 330),
    (7.6, 245, 335), (8.2, tabT, 95),        // 统计
    (8.6, tabT, 95), (9.3, 300, 290),
    (10.9, 300, 290), (11.5, 62, 622),       // 齿轮
    (11.9, 62, 622), (12.9, darkX, 148),     // 深色
    (13.4, darkX, 148), (14.9, 62, 62),      // 返回
    (15.3, 62, 62), (16.0, 250, 300),
    (17.2, 250, 300), (17.9, start.0, start.1), (18.0, start.0, start.1),
]
let clicks: [(Double, Double, Double)] = [
    (1.4, 337, 15), (4.9, tabS, 95), (8.3, tabT, 95), (11.6, 62, 622), (13.0, darkX, 148), (15.0, 62, 62),
]
_ = tabU

func ease(_ t: Double) -> Double { t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2 }

func cursorAt(_ t: Double) -> (Double, Double) {
    for i in 0..<(keys.count - 1) where t >= keys[i].0 && t <= keys[i + 1].0 {
        let (t0, x0, y0) = keys[i], (t1, x1, y1) = keys[i + 1]
        let u = t1 > t0 ? ease((t - t0) / (t1 - t0)) : 1
        return (x0 + (x1 - x0) * u, y0 + (y1 - y0) * u)
    }
    return (keys.last!.1, keys.last!.2)
}

let cursor = NSCursor.arrow
let curImg = cursor.image, hot = cursor.hotSpot
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.interpolationQuality = .high
let full = CGRect(x: 0, y: 0, width: W, height: H)
let ns = NSGraphicsContext(cgContext: ctx, flipped: false)
let out = FileHandle.standardOutput

let n = Int(total * fps)
for f in 0..<n {
    let t = Double(f) / fps
    // 底图 + 正在淡入的新画面
    var base = scenes[0].1
    var fading: (CGImage, Double)? = nil
    for (st, img, dur) in scenes where t >= st {
        if dur > 0 && t < st + dur { fading = (img, (t - st) / dur) } else { base = img; fading = nil }
    }
    ctx.setAlpha(1)
    ctx.draw(base, in: full)
    if let (img, p) = fading {
        ctx.setAlpha(ease(p))
        ctx.draw(img, in: full)
        ctx.setAlpha(1)
    }

    // 点击涟漪 + 光标按下缩放
    var press = 1.0
    for (ct, cx, cy) in clicks where t >= ct && t < ct + 0.45 {
        let p = (t - ct) / 0.45
        let r = (6 + 16 * ease(p)) * S
        let alpha = 0.45 * (1 - p)
        let c = CGPoint(x: cx * S, y: Double(H) - cy * S)
        ctx.setFillColor(CGColor(red: 0.2, green: 0.45, blue: 1, alpha: alpha * 0.35))
        ctx.fillEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
        ctx.setStrokeColor(CGColor(red: 0.2, green: 0.45, blue: 1, alpha: alpha))
        ctx.setLineWidth(1.5 * S)
        ctx.strokeEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
        if t < ct + 0.12 { press = 0.88 }
    }

    let (x, y) = cursorAt(t)
    let k = 1.1 * press * S
    let rect = NSRect(x: x * S - hot.x * k, y: Double(H) - (y * S - hot.y * k) - curImg.size.height * k,
                      width: curImg.size.width * k, height: curImg.size.height * k)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ns
    curImg.draw(in: rect)
    NSGraphicsContext.restoreGraphicsState()

    // CGContext 内存是自上而下的行序，直接写出即可
    let data = Data(bytesNoCopy: ctx.data!, count: W * H * 4, deallocator: .none)
    out.write(data)
}
