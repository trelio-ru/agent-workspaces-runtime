// Test-only in-memory AX transport. Production traversal, field resolution and
// readiness methods are inserted unchanged by the Node harness. No URL/value
// read or setter is implemented here, so reaching nested controls fails loudly.
import Foundation
import CoreFoundation

final class FixtureElement: NSObject {
    let role: String
    let id: String?
    var parent: FixtureElement?
    var nodes: [FixtureElement] = []
    var shown = true
    var enabled = true
    var writable = true
    var forbidChildren = false
    var delayedChildren: (() -> [FixtureElement])?
    init(_ role: String, _ id: String? = nil) { self.role = role; self.id = id }
    func append(_ child: FixtureElement) { nodes.append(child); child.parent = self }
}
typealias AXUIElement = FixtureElement
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
    if name == "AXDOMIdentifier" { return element.id }
    preconditionFailure("Unexpected attribute read")
}
func attribute(_ element: AXUIElement, _ name: String) -> Any? {
    precondition(name == kAXEnabledAttribute)
    return element.enabled
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    precondition(!element.forbidChildren, "Nested document traversal is forbidden")
    return element.delayedChildren?() ?? element.nodes
}
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

// A visible child document is structural evidence only. Its URL/controls are
// deliberately unreadable, covering a foreign origin and duplicate child IDs.
expect("nested_document_unsupported") { _ = try Session.controls(document, step) }
nested.shown = false
expect("field_not_found") { _ = try Session.controls(document, step) }
nested.shown = true
document.append(username)
expect("nested_document_unsupported") { _ = try Session.controls(document, step) }
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
expect("nested_document_unsupported") { _ = try Session.preparedControls(document, step) }
print("Native AX nested-document diagnostics passed")
