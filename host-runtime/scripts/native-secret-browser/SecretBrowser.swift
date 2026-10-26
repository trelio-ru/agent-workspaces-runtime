// Generic AX adapter. No focus, clipboard, keyboard simulation, screenshots,
// browser runtime sockets or AXValue reads on fields. Values arrive only after
// successful prepare, through the owning bridge's inherited anonymous stdin.
import Foundation
// Distributed only inside the independently signed host runtime package.
import AppKit
import ApplicationServices
import Security
import CryptoKit

// A kernel lease serializes native fills across local client sessions. The OS
// releases it even when a bridge/helper crashes; no stale PID-file takeover or
// concurrent username/password setters are possible.
final class NativeLease {
    let descriptor: Int32
    init() throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[0])
            .deletingLastPathComponent().deletingLastPathComponent()
        let file = directory.appendingPathComponent("active.lock").path
        descriptor = Darwin.open(file, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw Stop.failed("adapter_error") }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_uid == getuid(),
              (metadata.st_mode & 0o077) == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
              flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(descriptor)
            throw Stop.failed("browser_unavailable")
        }
    }
    deinit { Darwin.close(descriptor) }
}

enum Stop: Error {
    case failed(String)
    case unavailable(String)
    case bounded(WalkDiagnostic)
}
// Only these closed structural dimensions may leave the native process. They
// contain no app/page identity, DOM attributes, URLs, paths or field values.
enum WalkStage: String { case documentDiscovery = "document_discovery", frameDiscovery = "frame_discovery", fieldResolution = "field_resolution", activationResolution = "activation_resolution" }
enum WalkLimit: String { case nodeCount = "node_count", deadline }
struct WalkDiagnostic { let stage: WalkStage; let limit: WalkLimit }
struct Field: Decodable { let fieldKey: String; let id: String?; let passwordInput: Bool?; var accessibleName: String? = nil }
struct FrameTarget: Decodable { let targetOrigin: String; let targetUrlSha256: String }
struct Step: Decodable {
    let targetOrigin: String
    let targetUrlSha256: String
    let fields: [Field]
    let activationId: String?
    let submitId: String?
    var frames: [FrameTarget]? = nil
}
struct Request: Decodable {
    let command: String
    let clientFamily: String?
    let steps: [Step]?
    let values: [String: String]?
}
func reply(_ status: String, _ reason: String? = nil, _ diagnostic: WalkDiagnostic? = nil) {
    var object: [String: Any] = ["status": status]
    if let reason = reason { object["reasonCode"] = reason }
    if let diagnostic = diagnostic {
        object["diagnostic"] = ["stage": diagnostic.stage.rawValue, "limit": diagnostic.limit.rawValue]
    }
    if let data = try? JSONSerialization.data(withJSONObject: object) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func text(_ element: AXUIElement, _ name: String) -> String? {
    return attribute(element, name) as? String
}
func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    return attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}
func rectangle(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute),
          let size = attribute(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &extent),
          extent.width > 0, extent.height > 0 else { return nil }
    return CGRect(origin: point, size: extent)
}
func documentURL(_ element: AXUIElement) -> String? {
    // AXURL is read only for a WebArea, never an input's value.
    guard text(element, kAXRoleAttribute) == "AXWebArea" else { return nil }
    if let url = attribute(element, "AXURL") as? URL { return url.absoluteString }
    return text(element, "AXURL")
}
func matchesTarget(_ raw: String?, _ targetOrigin: String, _ targetUrlSha256: String) -> Bool {
    guard let raw = raw, let url = URL(string: raw), url.scheme == "https",
          url.user == nil, url.password == nil, let host = url.host else { return false }
    let port = url.port.map { $0 == 443 ? "" : ":" + String($0) } ?? ""
    let origin = "https://" + (host.contains(":") && !host.hasPrefix("[") ? "[" + host + "]" : host) + port
    let digest = SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    return origin == targetOrigin && digest == targetUrlSha256
}
func matches(_ raw: String?, _ step: Step) -> Bool { return matchesTarget(raw, step.targetOrigin, step.targetUrlSha256) }
func matches(_ raw: String?, _ frame: FrameTarget) -> Bool { return matchesTarget(raw, frame.targetOrigin, frame.targetUrlSha256) }

func belongs(_ child: AXUIElement, to ancestor: AXUIElement) -> Bool {
    var cursor: AXUIElement? = child
    for _ in 0..<128 {
        guard let current = cursor else { return false }
        if CFEqual(current, ancestor) { return true }
        cursor = elementAttribute(current, kAXParentAttribute)
    }
    return false
}
func visible(_ element: AXUIElement, in document: AXUIElement) -> Bool {
    guard (attribute(element, "AXHidden") as? Bool) != true,
          let frame = rectangle(element), let page = rectangle(document),
          frame.intersects(page) else { return false }
    return true
}

func matchesField(_ element: AXUIElement, _ field: Field) -> Bool {
    if let name = field.accessibleName {
        // Shadow-root inputs may have no AXDOMIdentifier. Match only the exact
        // native field name observed on the empty page, never surrounding text,
        // label order or AXValue. Native identity is still pinned before input.
        guard field.id == nil, field.passwordInput != true,
              ["AXTextField", "AXTextArea"].contains(text(element, kAXRoleAttribute) ?? "") else { return false }
        let title = text(element, kAXTitleAttribute).flatMap { $0.isEmpty ? nil : $0 }
        let actual = title ?? text(element, kAXDescriptionAttribute)
        return actual?.precomposedStringWithCanonicalMapping == name
    }
    // AXSecureTextField is Chromium's native representation of a password
    // input, not its accessible label or its (unread) current value. Reject
    // malformed mixed locators rather than weakening id-bound grants.
    if field.passwordInput == true {
        return field.id == nil && text(element, kAXRoleAttribute) == "AXTextField"
            && text(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole
    }
    return field.id != nil && text(element, "AXDOMIdentifier") == field.id
}

// Keep the original 12,000 unique-node / 12-second allowance. Monotonic time
// also bounds metadata filtering after the walk; wall-clock changes and another
// root alias must not restart a discovery budget. This internal type has no
// Request/JSON representation and provides no caller-controlled budget override.
struct WalkBudget {
    let stage: WalkStage
    let deadline: TimeInterval
    init(stage: WalkStage, deadline: TimeInterval = ProcessInfo.processInfo.systemUptime + 12) {
        self.stage = stage; self.deadline = deadline
    }
    func check(_ queued: Int) throws {
        if queued > 12000 { throw Stop.bounded(WalkDiagnostic(stage: stage, limit: .nodeCount)) }
        if ProcessInfo.processInfo.systemUptime > deadline { throw Stop.bounded(WalkDiagnostic(stage: stage, limit: .deadline)) }
    }
}
func walk(_ root: AXUIElement, stopAtWebArea: Bool = false, stage: WalkStage = .fieldResolution) throws -> [AXUIElement] {
    return try walkRoots([root], stopAtWebArea: stopAtWebArea, budget: WalkBudget(stage: stage))
}
func walkRoots(_ roots: [AXUIElement], stopAtWebArea: Bool = false, budget: WalkBudget) throws -> [AXUIElement] {
    var queue: [AXUIElement] = []
    var result: [AXUIElement] = []
    var index = 0
    var callbacks = kCFTypeSetCallBacks
    guard let seen = CFSetCreateMutable(kCFAllocatorDefault, 0, &callbacks) else { throw Stop.failed("adapter_error") }
    func enqueue(_ element: AXUIElement) throws {
        let pointer = Unmanaged.passUnretained(element).toOpaque()
        if CFSetContainsValue(seen, pointer) { return }
        try budget.check(queue.count + 1)
        CFSetAddValue(seen, pointer)
        queue.append(element)
    }
    for root in roots { try enqueue(root) }
    while index < queue.count {
        try budget.check(queue.count)
        let current = queue[index]
        index += 1
        if budget.stage == .documentDiscovery {
            // A web document is a discovery result, never a subtree to search
            // for another tab. In particular, unrelated Chrome/Codex content
            // must not exhaust the allowance before the target URL is chosen.
            // Keep traversing non-HTTP shell WebAreas: an embedded browser can
            // live beneath a native/custom-URL Electron shell.
            if let url = documentURL(current) {
                result.append(current)
                if url.hasPrefix("https://") || url.hasPrefix("http://") { continue }
            }
        } else {
            result.append(current)
            if stopAtWebArea && !CFEqual(roots[0], current) && text(current, kAXRoleAttribute) == "AXWebArea" { continue }
        }
        for child in children(current) { try enqueue(child) }
    }
    try budget.check(queue.count)
    return result
}

final class Session {
    let lease: NativeLease
    let application: NSRunningApplication
    let appElement: AXUIElement
    let steps: [Step]
    let window: AXUIElement
    let container: AXUIElement
    var rootDocument: AXUIElement
    var frameDocuments: [AXUIElement]
    var document: AXUIElement
    var targets: [AXUIElement]
    var button: AXUIElement?
    var used = false
    let requirement: SecRequirement

    static func trust(_ application: NSRunningApplication, _ requirement: SecRequirement) -> Bool {
        var code: SecCode?
        let attributes = [kSecGuestAttributePid as String: application.processIdentifier] as CFDictionary
        return SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess
            && code != nil && SecCodeCheckValidity(code!, SecCSFlags(), requirement) == errSecSuccess
    }
    static func documents(_ root: AXUIElement) throws -> [AXUIElement] { return try documentCandidates([root]) }
    static func documentCandidates(_ roots: [AXUIElement]) throws -> [AXUIElement] {
        let budget = WalkBudget(stage: .documentDiscovery)
        let nodes = try walkRoots(roots, budget: budget)
        let found = try nodes.filter { candidate in
            try budget.check(nodes.count)
            guard documentURL(candidate) != nil, rectangle(candidate) != nil,
                  (attribute(candidate, "AXHidden") as? Bool) != true else { return false }
            // A top-level embedded view can be nested under the Electron shell,
            // but a web document nested in another HTTPS document is an iframe.
            var cursor = elementAttribute(candidate, kAXParentAttribute)
            for _ in 0..<128 {
                try budget.check(nodes.count)
                guard let parent = cursor else { return true }
                if let url = documentURL(parent), url.hasPrefix("https://") || url.hasPrefix("http://") { return false }
                cursor = elementAttribute(parent, kAXParentAttribute)
            }
            return false
        }
        try budget.check(nodes.count)
        return found
    }
    static func applicationDocuments(_ application: AXUIElement) throws -> [AXUIElement] {
        // An inactive Electron client may leave its application-level
        // AXChildren/AXWindows empty even while its last main window remains
        // addressable through AXMainWindow or AXFocusedWindow. Read those
        // documented window attributes without activating, raising or focusing
        // the client. Exact URL, top-level document and control checks below
        // still gate every candidate before any secret is consumed.
        var roots = [application]
        for key in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
            if let window = elementAttribute(application, key as String),
               !roots.contains(where: { CFEqual($0, window) }) {
                roots.append(window)
            }
        }
        // Application/main/focused roots commonly overlap. Traverse them once
        // under one budget and deduplicate by native identity, never by URL:
        // two independent tabs at the same URL must remain ambiguous.
        return try documentCandidates(roots)
    }
    static func boundDocument(_ root: AXUIElement, _ step: Step) throws -> (AXUIElement, [AXUIElement]) {
        var current = root
        var path = [root]
        guard (step.frames?.count ?? 0) <= 4 else { throw Stop.failed("adapter_error") }
        for target in step.frames ?? [] {
            guard target.targetOrigin == step.targetOrigin else { throw Stop.failed("target_origin_changed") }
            // walk stops at immediate WebArea boundaries. Do not search another
            // frame for a matching field or treat a same-origin URL as consent
            // to a different path. Every explicitly requested hop is unique.
            let candidates = try walk(current, stopAtWebArea: true, stage: .frameDiscovery).filter {
                !CFEqual($0, current) && text($0, kAXRoleAttribute) == "AXWebArea"
            }
            let exact = candidates.filter { matches(documentURL($0), target) }
            guard exact.count <= 1 else { throw Stop.failed("field_ambiguous") }
            guard let next = exact.first else {
                if candidates.isEmpty || candidates.allSatisfy({ documentURL($0) == nil || documentURL($0) == "about:blank" }) {
                    throw Stop.failed("field_not_found")
                }
                throw Stop.failed("target_url_changed")
            }
            guard visible(next, in: current), belongs(next, to: current),
                  !path.contains(where: { CFEqual($0, next) }) else { throw Stop.failed("target_url_changed") }
            path.append(next)
            current = next
        }
        return (current, path)
    }
    static func checkBoundDocument(_ root: AXUIElement, _ leaf: AXUIElement, _ pinned: [AXUIElement], _ step: Step) throws {
        guard matches(documentURL(root), step) else { throw Stop.failed("target_url_changed") }
        let (current, path) = try boundDocument(root, step)
        guard CFEqual(current, leaf), path.count == pinned.count,
              zip(path, pinned).allSatisfy({ CFEqual($0.0, $0.1) }) else { throw Stop.failed("target_url_changed") }
    }
    static func preparedDocument(_ root: AXUIElement, _ step: Step) throws -> (AXUIElement, [AXUIElement]) {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            do { return try boundDocument(root, step) }
            catch Stop.failed("field_not_found") { Thread.sleep(forTimeInterval: 0.1) }
        }
        throw Stop.failed("field_not_found")
    }
    static func controls(_ document: AXUIElement, _ step: Step) throws -> ([AXUIElement], AXUIElement?) {
        let nodes = try walk(document, stopAtWebArea: true)
        // The traversal includes each iframe's WebArea boundary, but never its
        // controls. Its presence explains a top-document miss without reading
        // the child URL, identifiers or values, and is NOT authority to enter
        // that document. A page can also have an unrelated iframe: report the
        // observed limitation, not a claim that the requested fields are there.
        func find(_ field: Field, button: Bool) throws -> AXUIElement {
            let found = nodes.filter { matchesField($0, field) && belongs($0, to: document) }
            // Inspect boundary visibility only on a miss, so a ready form's
            // repeated pre-setter checks perform no extra native AX requests.
            guard !found.isEmpty else { throw Stop.failed(missingControlReason(document, nodes)) }
            guard found.count == 1 else { throw Stop.failed("field_ambiguous") }
            let target = found[0]
            guard (attribute(target, kAXEnabledAttribute) as? Bool) == true, visible(target, in: document) else {
                throw Stop.failed("field_not_found")
            }
            if button {
                guard text(target, kAXRoleAttribute) == kAXButtonRole else { throw Stop.failed("field_selector_invalid") }
                var actions: CFArray?
                guard AXUIElementCopyActionNames(target, &actions) == .success,
                      (actions as? [String])?.contains(kAXPressAction) == true else { throw Stop.failed("submit_press_unavailable") }
            } else {
                guard ["AXTextField", "AXTextArea"].contains(text(target, kAXRoleAttribute) ?? "") else {
                    throw Stop.failed("field_selector_invalid")
                }
                var writable = DarwinBoolean(false)
                guard AXUIElementIsAttributeSettable(target, kAXValueAttribute as CFString, &writable) == .success,
                      writable.boolValue else { throw Stop.failed("field_value_unsettable") }
            }
            return target
        }
        let fields = try step.fields.map { try find($0, button: false) }
        for index in fields.indices {
            guard !fields[..<index].contains(where: { CFEqual($0, fields[index]) }) else { throw Stop.failed("field_ambiguous") }
        }
        let button = try step.submitId.map { try find(Field(fieldKey: "", id: $0, passwordInput: nil), button: true) }
        return (fields, button)
    }
    static func missingControlReason(_ document: AXUIElement, _ nodes: [AXUIElement]) -> String {
        return nodes.contains {
            !CFEqual($0, document) && text($0, kAXRoleAttribute) == "AXWebArea"
                && visible($0, in: document)
        } ? "nested_document_unbound" : "field_not_found"
    }
    static func preparedControls(_ document: AXUIElement, _ step: Step) throws -> ([AXUIElement], AXUIElement?) {
        let deadline = Date().addingTimeInterval(20)
        var activated = step.activationId == nil
        var missingReason = "field_not_found"
        while Date() < deadline {
            do {
                if !activated, let activationId = step.activationId {
                    let nodes = try walk(document, stopAtWebArea: true, stage: .activationResolution)
                    let matches = nodes.filter {
                        text($0, "AXDOMIdentifier") == activationId && belongs($0, to: document)
                    }
                    guard matches.count <= 1 else { throw Stop.failed("field_ambiguous") }
                    guard let action = matches.first,
                          (attribute(action, kAXEnabledAttribute) as? Bool) == true,
                          visible(action, in: document) else {
                        missingReason = matches.isEmpty ? missingControlReason(document, nodes) : "field_not_found"
                        Thread.sleep(forTimeInterval: 0.1)
                        continue
                    }
                    var actions: CFArray?
                    guard AXUIElementCopyActionNames(action, &actions) == .success,
                          (actions as? [String])?.contains(kAXPressAction) == true,
                          AXUIElementPerformAction(action, kAXPressAction as CFString) == .success else {
                        throw Stop.failed("field_write_failed")
                    }
                    // The activation is exact and value-free. Perform it once,
                    // then wait for the same document to expose the bound fields.
                    activated = true
                    Thread.sleep(forTimeInterval: 0.1)
                }
                return try controls(document, step)
            } catch Stop.failed(let reason) where reason == "field_not_found" || reason == "nested_document_unbound" {
                // Preserve the ordinary readiness grace: an unrelated iframe
                // must not make a still-loading top-level form fail early.
                // Only the last observed miss explains the final refusal.
                missingReason = reason
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        throw Stop.failed(missingReason)
    }
    init(_ request: Request) throws {
        lease = try NativeLease()
        guard AXIsProcessTrusted() else { throw Stop.unavailable("access_required") }
        let bundle: String
        let team: String
        switch request.clientFamily {
        case "codex": bundle = "com.openai.codex"; team = "2DC432GLL2"
        case "claude-code": bundle = "com.anthropic.claudefordesktop"; team = "Q6L2SF6YDW"
        default: throw Stop.unavailable("client_unsupported")
        }
        guard let steps = request.steps, !steps.isEmpty, steps.count <= 10,
              steps.allSatisfy({ !$0.fields.isEmpty && $0.fields.count <= 50 }) else { throw Stop.failed("adapter_error") }
        self.steps = steps
        // Id-less password forms can already be authenticated in the user's
        // Chrome. Select that existing signed application by exact top-level
        // URL; never copy cookies, open another profile or guess a tab. Only
        // this explicit secure-field locator opts into external Chrome.
        var identities = [(bundle, team)]
        if steps.contains(where: { $0.fields.contains(where: { $0.passwordInput == true }) }) {
            identities.append(("com.google.Chrome", "EQHXZ8M8AV"))
        }
        let applications = NSWorkspace.shared.runningApplications.filter { app in
            identities.contains(where: { $0.0 == app.bundleIdentifier })
        }
        guard !applications.isEmpty else { throw Stop.unavailable("application_unavailable") }
        var candidates: [(NSRunningApplication, AXUIElement, AXUIElement, SecRequirement)] = []
        var exposedDocuments = 0
        for app in applications {
            guard let identity = identities.first(where: { $0.0 == app.bundleIdentifier }) else { throw Stop.failed("adapter_error") }
            var parsedRequirement: SecRequirement?
            let rule = "anchor apple generic and identifier \"" + identity.0 + "\" and certificate leaf[subject.OU] = \"" + identity.1 + "\""
            guard SecRequirementCreateWithString(rule as CFString, SecCSFlags(), &parsedRequirement) == errSecSuccess,
                  let requirement = parsedRequirement else { throw Stop.failed("adapter_error") }
            guard Session.trust(app, requirement) else { throw Stop.failed("adapter_error") }
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(ax, 1)
            // Documented Electron switch; it exposes the accessibility tree but
            // does not grant TCC permission or change any browser/site policy.
            AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            let docs = try Session.applicationDocuments(ax)
            exposedDocuments += docs.count
            for doc in docs where matches(documentURL(doc), steps[0]) { candidates.append((app, ax, doc, requirement)) }
        }
        if candidates.isEmpty {
            if exposedDocuments == 0 { throw Stop.unavailable("accessibility_unavailable") }
            throw Stop.failed("target_url_changed")
        }
        guard candidates.count == 1 else { throw Stop.failed("field_ambiguous") }
        (application, appElement, rootDocument, requirement) = candidates[0]
        guard let window = elementAttribute(rootDocument, kAXWindowAttribute) else { throw Stop.failed("adapter_error") }
        self.window = window
        // Pin the native view containing this single document, not the entire
        // app window. A later step must not jump to a different browser tab.
        guard let container = elementAttribute(rootDocument, kAXParentAttribute),
              try Session.documents(container).count == 1 else { throw Stop.unavailable("accessibility_unavailable") }
        self.container = container
        (document, frameDocuments) = try Session.preparedDocument(rootDocument, steps[0])
        (targets, button) = try Session.preparedControls(document, steps[0])
        try checkDocument(steps[0])
    }
    func checkDocument(_ step: Step) throws {
        guard !application.isTerminated, Session.trust(application, requirement),
              belongs(container, to: window), belongs(rootDocument, to: container),
              matches(documentURL(rootDocument), step) else { throw Stop.failed("target_url_changed") }
        try Session.checkBoundDocument(rootDocument, document, frameDocuments, step)
    }
    func fill(_ values: [String: String]) throws {
        guard !used else { throw Stop.failed("adapter_error") }
        used = true
        let keys = steps.flatMap { $0.fields.map { $0.fieldKey } }
        guard keys.count == Set(keys).count, Set(values.keys) == Set(keys) else { throw Stop.failed("adapter_error") }
        for (index, step) in steps.enumerated() {
            if index > 0 {
                let deadline = Date().addingTimeInterval(20)
                var found: AXUIElement?
                while Date() < deadline {
                    let docs = try Session.documents(container)
                    if docs.count > 1 { throw Stop.failed("field_ambiguous") }
                    if let next = docs.first {
                        if !matches(documentURL(next), step) && !matches(documentURL(next), steps[index - 1]) {
                            throw Stop.failed("target_url_changed")
                        }
                        if matches(documentURL(next), step) {
                            do {
                                let (leaf, path) = try Session.preparedDocument(next, step)
                                let prepared = try Session.preparedControls(leaf, step)
                                found = next
                                rootDocument = next
                                document = leaf
                                frameDocuments = path
                                targets = prepared.0
                                button = prepared.1
                                break
                            } catch Stop.failed("field_not_found") {
                                // Same-document/SPA transitions can expose the
                                // destination URL before its fields are ready.
                            }
                        }
                    }
                    Thread.sleep(forTimeInterval: 0.1)
                }
                guard let next = found else { throw Stop.failed("timeout") }
                rootDocument = next
            }
            try checkDocument(step)
            let (current, currentButton) = try Session.controls(document, step)
            guard zip(targets, current).allSatisfy({ CFEqual($0.0, $0.1) }),
                  targets.count == current.count,
                  (button == nil && currentButton == nil) || (button != nil && currentButton != nil && CFEqual(button!, currentButton!))
            else { throw Stop.failed("field_write_failed") }
            for (field, target) in zip(step.fields, targets) {
                try checkDocument(step)
                let (fresh, _) = try Session.controls(document, step)
                guard zip(fresh, targets).allSatisfy({ CFEqual($0.0, $0.1) }), fresh.count == targets.count else {
                    throw Stop.failed("field_write_failed")
                }
                guard belongs(target, to: document), matchesField(target, field),
                      let value = values[field.fieldKey] else { throw Stop.failed("field_write_failed") }
                // Chromium's AX kSetValue dispatches input/change events. It
                // writes the bound element directly even if focus moves.
                guard AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFString) == .success else {
                    throw Stop.failed("field_write_failed")
                }
            }
            if let button = button {
                try checkDocument(step)
                let (_, freshButton) = try Session.controls(document, step)
                guard freshButton != nil, CFEqual(button, freshButton!), belongs(button, to: document),
                      AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
                    throw Stop.failed("field_write_failed")
                }
            }
        }
        withExtendedLifetime(lease) {}
    }
}

// A fixed wall-clock lifetime limits an abandoned stdin session. Unexpected
// errors are always replaced with safe reason codes, never localized OS text.
let lifetime = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
lifetime.schedule(deadline: .now() + 120)
lifetime.setEventHandler { exit(1) }
lifetime.resume()
var session: Session?
var requestCount = 0
while let line = readLine(strippingNewline: true) {
    do {
        guard line.utf8.count <= 8 * 1024 * 1024, requestCount < 2 else { throw Stop.failed("adapter_error") }
        requestCount += 1
        let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
        if request.command == "prepare", session == nil {
            session = try Session(request)
            reply("ready")
        } else if request.command == "fill", let current = session, let values = request.values {
            try current.fill(values)
            reply("succeeded")
            break
        } else { throw Stop.failed("adapter_error") }
    } catch Stop.unavailable(let reason) { reply("unavailable", reason); break }
      catch Stop.bounded(let diagnostic) { reply("failed", "timeout", diagnostic); break }
      catch Stop.failed(let reason) { reply("failed", reason); break }
      catch { reply("failed", "adapter_error"); break }
}
