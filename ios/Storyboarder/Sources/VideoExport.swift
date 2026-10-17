import Foundation
import AVFoundation
import ImageIO
import CoreGraphics

/// Turns rendered board JPEGs into an H.264 MP4, honoring each board's duration.
enum VideoExport {

    static func write(jpegFrames: [Data], durationsMs: [Int], fps: Int32, to url: URL,
                      completion: @escaping (Bool) -> Void) {
        let images: [CGImage] = jpegFrames.compactMap { data -> CGImage? in
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            return CGImageSourceCreateImageAtIndex(source, 0, nil)
        }
        guard !images.isEmpty, images.count == jpegFrames.count else { completion(false); return }

        let width = images[0].width
        let height = images[0].height
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { completion(false); return }

        let compression: [String: Any] = [
            AVVideoAverageBitRateKey: 10_000_000,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2
        ]
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: compression
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false

        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attrs)

        guard writer.canAdd(input) else { completion(false); return }
        writer.add(input)
        guard writer.startWriting() else { completion(false); return }
        writer.startSession(atSourceTime: .zero)

        var schedule: [Int] = []
        for (index, ms) in durationsMs.enumerated() {
            let frames = max(1, Int((Double(max(ms, 100)) / 1000.0 * Double(fps)).rounded()))
            schedule.append(contentsOf: repeatElement(index, count: frames))
        }

        let queue = DispatchQueue(label: "com.sakuraentropia.storyboarder.video")
        var cursor = 0

        input.requestMediaDataWhenReady(on: queue) {
            while input.isReadyForMoreMediaData {
                if cursor >= schedule.count {
                    input.markAsFinished()
                    writer.finishWriting { completion(writer.status == .completed) }
                    return
                }
                let board = schedule[cursor]
                guard let pool = adaptor.pixelBufferPool,
                      let buffer = pixelBuffer(from: images[board], pool: pool, width: width, height: height) else {
                    writer.cancelWriting()
                    completion(false)
                    return
                }
                let time = CMTime(value: CMTimeValue(cursor), timescale: fps)
                if !adaptor.append(buffer, withPresentationTime: time) {
                    writer.cancelWriting()
                    completion(false)
                    return
                }
                cursor += 1
            }
        }
    }

    private static func pixelBuffer(from image: CGImage, pool: CVPixelBufferPool,
                                    width: Int, height: Int) -> CVPixelBuffer? {
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        guard let buffer = out else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }

        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        guard let context = CGContext(data: base, width: width, height: height,
                                      bitsPerComponent: 8, bytesPerRow: rowBytes,
                                      space: colorSpace, bitmapInfo: bitmapInfo) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return buffer
    }
}
