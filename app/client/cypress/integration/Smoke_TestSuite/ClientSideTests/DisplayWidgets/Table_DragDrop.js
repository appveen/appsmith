const widgetsPage = require("../../../../locators/Widgets.json");
const commonlocators = require("../../../../locators/commonlocators.json");
const explorer = require("../../../../locators/explorerlocators.json");

describe("Table Widget DragDrop cases", function() {
  it("1. Table Widget Functionality To Check with changing schema of tabledata", () => {
    cy.get(explorer.addWidget).click();
    cy.dragAndDropToCanvas("switchwidget", { x: 200, y: 200 });
    cy.dragAndDropToCanvas("tablewidget", { x: 200, y: 300 });
    cy.wait(3000);
    cy.openPropertyPane("tablewidget");
    cy.widgetText("Table1", widgetsPage.tableWidget, commonlocators.tableInner);
    cy.testJsontext(
      "tabledata",
      `{{
      Switch1.isSwitchedOn ? [
          {
            name: "joe"
          }
        ] : [
          {
            employee_name: "john"
          }
        ];
    }}`,
    );
    cy.wait("@updateLayout");
    cy.PublishtheApp();
    cy.wait(2000);
    cy.getTableDataSelector("0", "0").then((element) => {
      cy.get(element).should("be.visible");
    });
    cy.readTabledataPublish("0", "0").then((value) => {
      expect(value).to.be.equal("joe");
    });
    cy.get(".t--switch-widget-active")
      .first()
      .click();
    cy.wait(1000);
    cy.getTableDataSelector("0", "0").then((element) => {
      cy.get(element).should("be.visible");
    });
    cy.readTabledataPublish("0", "0").then((value) => {
      expect(value).to.be.equal("john");
    });
    cy.get(".t--switch-widget-inactive")
      .first()
      .click();
    cy.wait(1000);
    cy.getTableDataSelector("0", "0").then((element) => {
      cy.get(element).should("be.visible");
    });
    cy.readTabledataPublish("0", "0").then((value) => {
      expect(value).to.be.equal("joe");
    });
  });
});
