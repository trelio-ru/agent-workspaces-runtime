// Test-only in-memory AX transport. Production traversal, field resolution and
// readiness methods are inserted unchanged by the Node harness. Only document
// URLs are readable; there is no field-value reader or setter. Legacy lookup
// must not enter nested controls without an explicit bound frame path.
import Foundation
import CoreFoundation
import CoreGraphics
import CryptoKit

final class FixtureElement: NSObject {
    let role: String
    let id: String?
    var name: String?
    var detail: String?
    var placeholder: String?
    var secure = false
    var url: String?
    var parent: FixtureElement?
    var nodes: [FixtureElement] = []
    var windows: [FixtureElement] = []
    var mainWindow: FixtureElement?
    var focusedWindow: FixtureElement?
    var shown = true
    var enabled = true
    var writable = true
    var forbidChildren = false
    var delayedChildren: (() -> [FixtureElement])?
    init(_ role: String, _ id: String? = nil) { self.role = role; self.id = id }
    func append(_ child: FixtureElement) { nodes.append(child); child.parent = self }
}
typealias AXUIElement = FixtureElement
let kAXParentAttribute = "AXParent"
let kAXWindowsAttribute = "AXWindows"
let kAXMainWindowAttribute = "AXMainWindow"
let kAXFocusedWindowAttribute = "AXFocusedWindow"
let kAXTitleAttribute = "AXTitle"
let kAXDescriptionAttribute = "AXDescription"
let kAXRoleAttribute = "AXRole"
let kAXEnabledAttribute = "AXEnabled"
let kAXSubroleAttribute = "AXSubrole"
let kAXSecureTextFieldSubrole = "AXSecureTextField"
let kAXButtonRole = "AXButton"
let kAXPressAction = "AXPress"
let kAXValueAttribute = "AXValue"
enum FixtureResult { case success }
func text(_ element: AXUIElement, _ name: String) -> String? {
    if name == kAXRoleAttribute { return element.role }
    if name == kAXSubroleAttribute { return element.secure ? kAXSecureTextFieldSubrole : nil }
    if name == "AXDOMIdentifier" { return element.id }
    if name == kAXTitleAttribute { return element.name }
    if name == kAXDescriptionAttribute { return element.detail }
    if name == "AXPlaceholderValue" { return element.placeholder }
    preconditionFailure("Unexpected attribute read")
}
func attribute(_ element: AXUIElement, _ name: String) -> Any? {
    if name == "AXHidden" { return !element.shown }
    if name == kAXWindowsAttribute { return element.windows }
    precondition(name == kAXEnabledAttribute)
    return element.enabled
}
func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    switch name {
    case kAXParentAttribute: return element.parent
    case kAXMainWindowAttribute: return element.mainWindow
    case kAXFocusedWindowAttribute: return element.focusedWindow
    default: preconditionFailure("Unexpected AX element attribute read")
    }
}
func rectangle(_ element: AXUIElement) -> CGRect? { return CGRect(x: 0, y: 0, width: 200, height: 100) }

func children(_ element: AXUIElement) -> [AXUIElement] {
    precondition(!element.forbidChildren, "Nested document traversal is forbidden")
    return element.delayedChildren?() ?? element.nodes
}
func documentURL(_ element: AXUIElement) -> String? { return element.role == "AXWebArea" ? element.url : nil }
func visible(_ element: AXUIElement, in document: AXUIElement) -> Bool { return element.shown }
func belongs(_ element: AXUIElement, to document: AXUIElement) -> Bool {
    var cursor: AXUIElement? = element
    for _ in 0..<128 {
        guard let current = cursor else { return false }
        if current === document { return true }
        cursor = current.parent
    }
    return false
}
func AXUIElementCopyActionNames(_ element: AXUIElement, _ actions: inout CFArray?) -> FixtureResult {
    actions = [kAXPressAction] as CFArray
    return .success
}
func AXUIElementIsAttributeSettable(_ element: AXUIElement, _ name: CFString, _ writable: inout DarwinBoolean) -> FixtureResult {
    writable = DarwinBoolean(element.writable)
    return .success
}
func AXUIElementPerformAction(_ element: AXUIElement, _ action: CFString) -> FixtureResult {
    preconditionFailure("This fixture must not activate or submit anything")
}

// PRODUCTION_CORE

// The SAME production admission lists include signed Chrome for every native
// locator, not only password-role plans. Unknown clients remain unsupported.
for family in ["codex", "claude-code"] {
    let identities = try Session.applicationIdentities(family)
    precondition(identities.count == 2)
    precondition(identities[1].0 == "com.google.Chrome" && identities[1].1 == "EQHXZ8M8AV")
}
do { _ = try Session.applicationIdentities("other"); preconditionFailure("Unknown client admitted") }
catch Stop.unavailable("client_unsupported") {}

// Discovery must inspect document metadata without walking unrelated page
// contents. A normal Chrome window can expose a much larger web tree than the
// bank form; that tree must not consume the form's native traversal allowance.
let discoveryApp = FixtureElement("AXApplication")
let unrelatedPage = FixtureElement("AXWebArea"); unrelatedPage.url = "https://unrelated.example.test/large"
for _ in 0..<12050 { unrelatedPage.append(FixtureElement("AXStaticText")) }
let selectedPage = FixtureElement("AXWebArea"); selectedPage.url = "https://bank.example.test/login"
discoveryApp.append(unrelatedPage); discoveryApp.append(selectedPage)
let discovered = try Session.documents(discoveryApp)
precondition(discovered.count == 2 && discovered[1] === selectedPage)
// No fields of either selected or unrelated documents participate in discovery.
unrelatedPage.forbidChildren = true; selectedPage.forbidChildren = true
let aliases = try Session.documentCandidates([discoveryApp, discoveryApp, selectedPage])
precondition(aliases.count == 2)
// Native-object deduplication must not hide a second tab with the same URL.
let anotherTab = FixtureElement("AXWebArea"); anotherTab.url = selectedPage.url; anotherTab.forbidChildren = true
discoveryApp.append(anotherTab)
let distinct = try Session.documents(discoveryApp)
precondition(distinct.filter { $0.url == selectedPage.url }.count == 2)

// An exact login document can be in a signed Chrome window reported only via
// AXWindows. The focused/main window reports a different document. Sharing an
// object across root views must not manufacture ambiguity or hide a real tab.
let chrome = FixtureElement("AXApplication")
let mainWindow = FixtureElement("AXWindow"); mainWindow.append(unrelatedPage)
let loginWindow = FixtureElement("AXWindow"); loginWindow.append(selectedPage)
chrome.append(mainWindow)
chrome.windows = [mainWindow, loginWindow, loginWindow]
chrome.mainWindow = mainWindow
chrome.focusedWindow = mainWindow
let chromeDocs = try Session.applicationDocuments(chrome)
precondition(chromeDocs.count == 2 && chromeDocs.contains { $0 === selectedPage })
let duplicateWindow = FixtureElement("AXWindow"); duplicateWindow.append(anotherTab)
chrome.windows.append(duplicateWindow)
let duplicateChromeDocs = try Session.applicationDocuments(chrome)
precondition(duplicateChromeDocs.filter { $0.url == selectedPage.url }.count == 2)
// A non-HTTP Electron shell is not an authorization boundary for its embedded
// browser. Its actual HTTP child still needs ordinary exact URL selection.
let shell = FixtureElement("AXWebArea"); shell.url = "codex://shell"
let embedded = FixtureElement("AXWebArea"); embedded.url = "https://bank.example.test/login"; embedded.forbidChildren = true
shell.append(embedded)
let shellDocuments = try Session.documents(shell)
precondition(shellDocuments.contains(where: { $0 === embedded }))
// Aliases/cycles in native child arrays cannot consume the allowance repeatedly.
let cycle = FixtureElement("AXGroup"); cycle.nodes = [cycle, cycle]
let cycleDocuments = try Session.documents(cycle)
precondition(cycleDocuments.isEmpty)
func expectBounded(_ stage: WalkStage, _ limit: WalkLimit, _ operation: () throws -> Void) {
    do { try operation(); preconditionFailure("Expected a bounded traversal refusal") }
    catch Stop.bounded(let diagnostic) { precondition(diagnostic.stage == stage && diagnostic.limit == limit) }
    catch { preconditionFailure("Unexpected traversal error") }
}
let crowdedShell = FixtureElement("AXGroup")
for _ in 0..<12000 { crowdedShell.append(FixtureElement("AXStaticText")) }
expectBounded(.documentDiscovery, .nodeCount) { _ = try Session.documents(crowdedShell) }
// The SAME production budget enforces the monotonic deadline; no slow real AX
// call, hidden fixture mode or altered production limit is required to test it.
let expiredBudget = WalkBudget(stage: .frameDiscovery, deadline: ProcessInfo.processInfo.systemUptime - 1)
expectBounded(.frameDiscovery, .deadline) { try expiredBudget.check(1) }

let document = FixtureElement("AXWebArea")
let username = FixtureElement("AXTextField", "username")
let password = FixtureElement("AXTextField", "password")
let nested = FixtureElement("AXWebArea", "bbvaIframe")
let nestedPassword = FixtureElement("AXTextField", "password")
nested.append(nestedPassword)
nested.forbidChildren = true
document.append(nested)
let step = Step(targetOrigin: "https://bank.example.test", targetUrlSha256: String(repeating: "0", count: 64),
                fields: [Field(fieldKey: "username", id: "username", passwordInput: nil),
                         Field(fieldKey: "password", id: "password", passwordInput: nil)],
                activationId: nil, submitId: nil)
func expect(_ reason: String, _ operation: () throws -> Void) {
    do { try operation(); preconditionFailure("Expected refusal") }
    catch Stop.failed(let actual) { precondition(actual == reason, "Unexpected closed reason") }
    catch { preconditionFailure("Unexpected error") }
}

// An id-less login modal may expose the phone only as a placeholder. Use the
// SAME production resolver with a second edit and a foreign iframe present.
// The fixture has no AXValue reader, even if name and placeholder disagree.
let login = FixtureElement("AXWebArea")
let phone = FixtureElement("AXTextField"); phone.placeholder = "Телефон"; phone.name = ""; phone.detail = ""
let secure = FixtureElement("AXTextField"); secure.secure = true; secure.placeholder = "Пароль"
let decorativeLabel = FixtureElement("AXStaticText"); decorativeLabel.placeholder = phone.placeholder
login.append(phone); login.append(secure); login.append(decorativeLabel)
let unrelatedFrame = FixtureElement("AXWebArea"); unrelatedFrame.forbidChildren = true
login.append(unrelatedFrame)
let phoneField = Field(fieldKey: "phone", id: nil, passwordInput: nil, accessibleName: "Телефон")
let loginStep = Step(targetOrigin: step.targetOrigin, targetUrlSha256: step.targetUrlSha256,
                     fields: [phoneField, Field(fieldKey: "password", id: nil, passwordInput: true)],
                     activationId: nil, submitId: nil)
let loginFields = try Session.controls(login, loginStep)
precondition(loginFields.0[0] === phone && loginFields.0[1] === secure && loginFields.1 == nil)
precondition(!matchesField(secure, Field(fieldKey: "password", id: nil, passwordInput: nil, accessibleName: "Пароль")))
precondition(!matchesField(phone, Field(fieldKey: "phone", id: nil, passwordInput: nil, accessibleName: "телефон")))
phone.detail = "Other purpose"
precondition(!matchesField(phone, phoneField))
phone.detail = nil
phone.name = "Other purpose"
precondition(!matchesField(phone, phoneField))
phone.name = nil
let duplicatePlaceholder = FixtureElement("AXTextField"); duplicatePlaceholder.placeholder = phone.placeholder
duplicatePlaceholder.shown = false; login.append(duplicatePlaceholder)
expect("field_ambiguous") { _ = try Session.controls(login, loginStep) }
duplicatePlaceholder.name = phone.placeholder // Explicit and placeholder matches must also conflict.
expect("field_ambiguous") { _ = try Session.controls(login, loginStep) }
login.nodes.removeLast()
phone.writable = false
expect("field_value_unsettable") { _ = try Session.controls(login, loginStep) }
phone.writable = true; phone.shown = false
expect("field_not_found") { _ = try Session.controls(login, loginStep) }

// Synthetic family signup: a generated DOM id and a submit button without id.
// Both exact-id and unique secure-role plans resolve the same native field,
// without a native submit or a value read. Each newly opened form is prepared
// independently; no expired grant or previously filled field is reused.
for id in ["floatingLabelInput11", "floatingLabelInput14"] {
    let signup = FixtureElement("AXWebArea")
    let input = FixtureElement("AXTextField", id); input.secure = true
    signup.append(input); signup.append(FixtureElement("AXButton"))
    for field in [Field(fieldKey: "password", id: id, passwordInput: nil),
                  Field(fieldKey: "password", id: nil, passwordInput: true)] {
        let plan = Step(targetOrigin: step.targetOrigin, targetUrlSha256: step.targetUrlSha256,
                        fields: [field], activationId: nil, submitId: nil)
        let selected = try Session.controls(signup, plan)
        precondition(selected.0.count == 1 && selected.0[0] === input && selected.1 == nil)
        let duplicate = FixtureElement("AXTextField", id); duplicate.secure = true; duplicate.shown = false
        signup.append(duplicate)
        expect("field_ambiguous") { _ = try Session.controls(signup, plan) }
        signup.nodes.removeLast()
    }
}

// A visible child document is structural evidence only. Its URL/controls are
// deliberately unreadable, covering a foreign origin and duplicate child IDs.
expect("nested_document_unbound") { _ = try Session.controls(document, step) }
nested.shown = false
expect("field_not_found") { _ = try Session.controls(document, step) }
nested.shown = true
document.append(username)
expect("nested_document_unbound") { _ = try Session.controls(document, step) }
document.append(password)
let resolved = try Session.controls(document, step)
precondition(resolved.0.count == 2 && resolved.0[1] === password)
let duplicate = FixtureElement("AXTextField", "password")
document.append(duplicate)
expect("field_ambiguous") { _ = try Session.controls(document, step) }
document.nodes.removeLast()
password.writable = false
expect("field_value_unsettable") { _ = try Session.controls(document, step) }
password.writable = true
password.shown = false
expect("field_not_found") { _ = try Session.controls(document, step) }
password.shown = true

// The presence of an unrelated iframe must not shorten the original readiness
// grace. Start with a missing top-level field, then expose its same native object.
let started = Date()
document.delayedChildren = { Date().timeIntervalSince(started) < 0.2 ? [nested, username] : [nested, username, password] }
let prepared = try Session.preparedControls(document, step)
precondition(prepared.0[1] === password)
document.delayedChildren = nil
document.nodes = [nested]
expect("nested_document_unbound") { _ = try Session.preparedControls(document, step) }
// Explicit frame bindings admit ONLY the requested immediate child. Native
// names resolve shadow-root edits without ever querying an input value.
func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
let rootURL = "https://bank.example.test/login"
let frameURL = "https://bank.example.test/form?view=bank"
document.url = rootURL; nested.url = frameURL; nested.forbidChildren = false
let frameUser = FixtureElement("AXTextField"); frameUser.name = "Código de empresa"
let framePassword = FixtureElement("AXTextField"); framePassword.name = "Clave de acceso"
nested.nodes = []; nested.append(frameUser); nested.append(framePassword)
var framed = Step(targetOrigin: "https://bank.example.test", targetUrlSha256: digest(rootURL),
                  fields: [Field(fieldKey: "username", id: nil, passwordInput: nil, accessibleName: "Código de empresa"),
                           Field(fieldKey: "password", id: nil, passwordInput: nil, accessibleName: "Clave de acceso")],
                  activationId: nil, submitId: nil)
framed.frames = [FrameTarget(targetOrigin: "https://bank.example.test", targetUrlSha256: digest(frameURL))]
let (leaf, pinned) = try Session.boundDocument(document, framed)
precondition(leaf === nested && pinned.count == 2)
let fields = try Session.controls(leaf, framed)
precondition(fields.0[0] === frameUser && fields.0[1] === framePassword)
try Session.checkBoundDocument(document, leaf, pinned, framed)
// Identical names outside the bound iframe do not alter its field selection.
username.name = "Código de empresa"; password.name = "Clave de acceso"
document.append(username); document.append(password)
let sameFields = try Session.controls(leaf, framed)
precondition(sameFields.0.count == 2)
let duplicateName = FixtureElement("AXTextField"); duplicateName.name = frameUser.name
nested.append(duplicateName)
expect("field_ambiguous") { _ = try Session.controls(leaf, framed) }
nested.nodes.removeLast()
// Same URL in two immediate children is ambiguous, including a hidden one.
let duplicateFrame = FixtureElement("AXWebArea"); duplicateFrame.url = frameURL; duplicateFrame.shown = false
document.append(duplicateFrame)
expect("field_ambiguous") { _ = try Session.boundDocument(document, framed) }
document.nodes.removeLast()
nested.url = "https://other.example.test/form"
expect("target_url_changed") { try Session.checkBoundDocument(document, leaf, pinned, framed) }
nested.url = frameURL + "&changed=1"
expect("target_url_changed") { try Session.checkBoundDocument(document, leaf, pinned, framed) }
nested.url = frameURL
document.url = rootURL + "?changed=1"
expect("target_url_changed") { try Session.checkBoundDocument(document, leaf, pinned, framed) }
document.url = rootURL
let replacement = FixtureElement("AXWebArea"); replacement.url = frameURL
replacement.append(FixtureElement("AXTextField", "password"))
document.nodes[0] = replacement; replacement.parent = document
expect("target_url_changed") { try Session.checkBoundDocument(document, leaf, pinned, framed) }
print("Native AX nested-document diagnostics passed")
