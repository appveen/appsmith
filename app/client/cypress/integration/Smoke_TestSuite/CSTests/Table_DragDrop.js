const widgetsPage = require("../../../locators/Widgets.json");
const commonlocators = require("../../../locators/commonlocators.json");
const explorer = require("../../../locators/explorerlocators.json");
import homePage from "../../../locators/HomePage.json";
const publish = require("../../../locators/publishWidgetspage.json");

describe("Table Widget DragDrop cases", function() {
  it("1. Table Widget Functionality To Check with changing schema of tabledata", () => {
    let jsContext = `{{Switch1.isSwitchedOn?[{name: "joe"}]:[{employee_name: "john"}];}}`;
    cy.NavigateToHome();
    cy.get(homePage.createNew)
      .first()
      .click({ force: true });
    cy.wait("@createNewApplication").should(
      "have.nested.property",
      "response.body.responseMeta.status",
      201,
    );
    cy.get(explorer.addWidget).click();
    cy.dragAndDropToCanvas("switchwidget", { x: 200, y: 200 });
    cy.dragAndDropToCanvas("tablewidget", { x: 200, y: 300 });
    cy.wait(1000);
    cy.wait("@updateLayout");
    //cy.openPropertyPane("tablewidget");
    //cy.widgetText("Table1", widgetsPage.tableWidget, commonlocators.tableInner);
    cy.testJsontext("tabledata", jsContext);
    cy.wait(2000);
    cy.wait("@updateLayout");
    // cy.wait("@updateLayout").then(({ response }) => {
    //   cy.log("Response is :" + JSON.stringify(response.body))
    //   //expect(response.body.data.dsl.children[1].tableData).to.eq(jsContext);
    // });
    cy.wait(2000); //waiting for AutoSave & then publishing!
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

    cy.get(publish.backToEditor)
      .first()
      .click()
      .wait(1000);
  });
});
